import os
import io
import pickle
import pandas as pd
from tqdm import tqdm
from typing import List, Dict, Any

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload

from langchain_community.document_loaders import Docx2txtLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter   # ← moved
from langchain_openai import ChatOpenAI, OpenAIEmbeddings             # ← moved
from langchain.chains.summarize import load_summarize_chain           # still OK
from langchain_core.documents import Document                         # ← moved
from langchain_core.prompts import PromptTemplate                     # ← moved

from dotenv import load_dotenv

# ——— Load environment variables ———
load_dotenv()

# ——— Config & Globals ———
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
backup_path = "summaries_backup_2025.pkl"
backup_every = 10

# Prefer current models
llm = ChatOpenAI(model="gpt-3.5-turbo", temperature=0, api_key=OPENAI_API_KEY)
chain = load_summarize_chain(llm, chain_type="refine", verbose=False)

splitter = RecursiveCharacterTextSplitter(chunk_size=2000, chunk_overlap=200)

embedder = OpenAIEmbeddings(model="text-embedding-ada-002", api_key=OPENAI_API_KEY)

creds = Credentials.from_authorized_user_file(
    "token.json", ["https://www.googleapis.com/auth/drive.readonly"]
)
service = build("drive", "v3", credentials=creds)

# ——— Load backup if it exists ———
if os.path.exists(backup_path):
    with open(backup_path, "rb") as f:
        out = pickle.load(f)
    print(f"[Resume] Loaded backup with {len(out['doc_id'])} documents.")
else:
    out = {"doc_id": [], "summary": [], "chunks": []}
    print("[Start] No backup found. Starting from scratch.")

already_processed = set(out["doc_id"])

# ——— Helper Functions for Excel Processing ———
def create_contextual_summary(chunks: List[Document], file_name: str, year: str, sheet_name: str = None) -> str:
    """
    Create a summary with file context (name, year, and optionally sheet name).
    """
    if not chunks:
        return "No content found"
    
    # Create context string
    if sheet_name:
        context = f"File: {file_name} (Year: {year}, Sheet: {sheet_name})"
    else:
        context = f"File: {file_name} (Year: {year})"
    
    # Create a custom prompt that includes context
    prompt = PromptTemplate.from_template(
        """You are summarizing data from: {context}

Please provide a comprehensive summary of the following content. Include:
- Key data insights and patterns
- Important numbers, trends, or findings
- The purpose and scope of this data
- Any notable observations

Begin your summary by mentioning the file context, then provide the analysis.

Content to summarize:
{text}

Summary:"""
    )
    
    # Combine all chunks text
    combined_text = "\n\n".join([chunk.page_content for chunk in chunks])
    
    # Generate summary with context
    try:
        formatted_prompt = prompt.format(context=context, text=combined_text[:4000])  # Limit text length
        response = llm.invoke(formatted_prompt)
        return response.content
    except Exception as e:
        print(f"[Error] Summary generation failed: {e}")
        return f"{context}: Error generating summary - {str(e)}"

def excel_to_text(file_path: str) -> Dict[str, str]:
    """
    Convert Excel file to text by reading all sheets and converting them to string format.
    Returns a dictionary where keys are sheet names and values are text content.
    """
    try:
        # Read all sheets from Excel file
        excel_file = pd.ExcelFile(file_path)
        sheet_texts = {}
        
        for sheet_name in excel_file.sheet_names:
            try:
                # Read the sheet
                df = pd.read_excel(file_path, sheet_name=sheet_name)
                
                # Convert DataFrame to a readable text format
                if not df.empty:
                    # Create a text representation of the sheet
                    text_content = f"Sheet: {sheet_name}\n"
                    text_content += "=" * (len(sheet_name) + 7) + "\n\n"
                    
                    # Add column headers
                    text_content += "Columns: " + ", ".join(str(col) for col in df.columns) + "\n\n"
                    
                    # Add data rows (limit to prevent extremely long text)
                    max_rows = 1000  # Limit rows to prevent overwhelming the LLM
                    df_limited = df.head(max_rows)
                    
                    for idx, row in df_limited.iterrows():
                        row_text = []
                        for col in df.columns:
                            value = row[col]
                            if pd.notna(value):
                                row_text.append(f"{col}: {value}")
                        
                        if row_text:  # Only add non-empty rows
                            text_content += " | ".join(row_text) + "\n"
                    
                    if len(df) > max_rows:
                        text_content += f"\n... (showing first {max_rows} of {len(df)} rows)\n"
                    
                    sheet_texts[sheet_name] = text_content
                else:
                    sheet_texts[sheet_name] = f"Sheet: {sheet_name}\n(Empty sheet)"
                    
            except Exception as e:
                print(f"[Warning] Error reading sheet '{sheet_name}': {e}")
                sheet_texts[sheet_name] = f"Sheet: {sheet_name}\n(Error reading sheet: {str(e)})"
        
        return sheet_texts
        
    except Exception as e:
        print(f"[Error] Failed to read Excel file: {e}")
        return {}

def create_documents_from_excel(sheet_texts: Dict[str, str]) -> List[Document]:
    """
    Convert sheet texts to LangChain Document objects.
    """
    documents = []
    
    for sheet_name, text_content in sheet_texts.items():
        if text_content.strip():  # Only process non-empty sheets
            doc = Document(
                page_content=text_content,
                metadata={"sheet_name": sheet_name, "source_type": "excel_sheet"}
            )
            documents.append(doc)
    
    return documents

def _as_text(x) -> str:
    if isinstance(x, str):
        return x
    if isinstance(x, dict):
        # common keys across LC versions
        for k in ("output_text", "text", "content"):
            if k in x and isinstance(x[k], str):
                return x[k]
    content = getattr(x, "content", None)
    if isinstance(content, str):
        return content
    return str(x)

# ——— Processing Functions by File Type ———
def process_docx_file(fid: str, file_name: str, year: str) -> tuple:
    """Process DOCX file and return summary and chunks."""
    mime_type = meta_map[fid]["mimeType"]
    fh = io.BytesIO()

    # Download document
    if mime_type == 'application/vnd.google-apps.document':
        request = service.files().export_media(
            fileId=fid,
            mimeType='application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        )
    elif mime_type == 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        request = service.files().get_media(fileId=fid)
    else:
        raise ValueError(f"Unsupported DOCX MIME type: {mime_type}")

    downloader = MediaIoBaseDownload(fh, request)
    while not downloader.next_chunk()[1]:
        pass

    # Load and split document
    fh.seek(0)
    with open("temp.docx", "wb") as temp_f:
        temp_f.write(fh.read())

    docs = Docx2txtLoader("temp.docx").load()
    chunks = splitter.split_documents(docs)
    
    result = chain.invoke({"input_documents": chunks})
    summary = result.get("output_text", result)

    # Clean up temporary file
    if os.path.exists("temp.docx"):
        os.remove("temp.docx")

    return summary, chunks

def process_excel_file(fid: str, file_name: str, year: str) -> tuple:
    """Process Excel file and return summary and chunks."""
    mime_type = meta_map[fid]["mimeType"]
    fh = io.BytesIO()

    # Download spreadsheet
    if mime_type == 'application/vnd.google-apps.spreadsheet':
        # Export Google Sheets as Excel format
        request = service.files().export_media(
            fileId=fid,
            mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        )
    elif mime_type == 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
        # Download Excel file directly
        request = service.files().get_media(fileId=fid)
    else:
        raise ValueError(f"Unsupported Excel MIME type: {mime_type}")

    downloader = MediaIoBaseDownload(fh, request)
    while not downloader.next_chunk()[1]:
        pass

    # Save to temporary file
    fh.seek(0)
    temp_file = "temp_excel.xlsx"
    with open(temp_file, "wb") as temp_f:
        temp_f.write(fh.read())

    # Process Excel file
    sheet_texts = excel_to_text(temp_file)
    
    if not sheet_texts:
        print(f"[Warning] No readable sheets found in {fid}")
        return f"File: {file_name} (Year: {year}): No readable content found", []

    # Create documents for each sheet
    all_documents = create_documents_from_excel(sheet_texts)
    
    # Split documents into chunks
    all_chunks = []
    for doc in all_documents:
        chunks = splitter.split_documents([doc])
        all_chunks.extend(chunks)

    # Generate overall summary from all chunks with context
    if all_chunks:
        overall_summary = create_contextual_summary(all_chunks, file_name, year)
    else:
        overall_summary = f"File: {file_name} (Year: {year}): No content found in spreadsheet"

    # Clean up temporary file
    if os.path.exists(temp_file):
        os.remove(temp_file)

    return overall_summary, all_chunks

# ——— Main function ———
def extract_data(file_ids: List[str]):
    failed_ids = []
    processed_count = 0
    skipped_count = 0

    print(f"[Info] Starting processing of {len(file_ids)} files")
    print(f"[Info] Already processed: {len(already_processed)} files will be skipped")

    for i, fid in enumerate(tqdm(file_ids, desc="Processing files")):
        if fid in already_processed:
            skipped_count += 1
            file_name = meta_map[fid].get("name", f"Unknown_File_{fid}")
            if skipped_count <= 5:  # Show first 5 skipped files
                print(f"[Skip] {file_name} (already processed)")
            elif skipped_count == 6:
                print(f"[Skip] ... (and {len(already_processed) - 5} more already processed files)")
            continue

        try:
            mime_type = meta_map[fid]["mimeType"]
            file_name = meta_map[fid].get("name", f"Unknown_File_{fid}")
            year = meta_map[fid].get("year", "Unknown")

            print(f"\n[Processing] {file_name} (Year: {year}) - MIME: {mime_type}")

            # Process based on MIME type
            if mime_type in [
                'application/vnd.google-apps.document',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            ]:
                # Process DOCX file
                summary, chunks = process_docx_file(fid, file_name, year)
                print(f"[DOCX] Processed document with {len(chunks)} chunks")
                
            elif mime_type in [
                'application/vnd.google-apps.spreadsheet',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            ]:
                # Process Excel file
                summary, chunks = process_excel_file(fid, file_name, year)
                print(f"[Excel] Processed spreadsheet with {len(chunks)} chunks")
                
            else:
                raise ValueError(f"Unsupported MIME type: {mime_type}")

            summary = _as_text(summary)
            # Store result in unified structure
            out["doc_id"].append(fid)
            out["summary"].append(summary)
            out["chunks"].append(chunks)

            processed_count += 1

            # Show summary for verification
            print(f"[Summary Preview] {summary[:200]}...")

        except Exception as e:
            print(f"[Error] {fid}: {e}")
            failed_ids.append(fid)
            continue

        # Periodic backup
        if processed_count > 0 and processed_count % backup_every == 0:
            with open(backup_path, "wb") as f:
                pickle.dump(out, f, protocol=pickle.HIGHEST_PROTOCOL)
            print(f"[Backup] Saved after {len(out['doc_id'])} total files")

    # Final backup
    with open(backup_path, "wb") as f:
        pickle.dump(out, f, protocol=pickle.HIGHEST_PROTOCOL)
    print(f"[Done] Final backup saved to {backup_path}")

    return out, failed_ids

# ——— Entry Point ———
if __name__ == "__main__":
    df = pd.read_csv("files_0AGhLXRXVGCy1Uk9PVA.csv")
    
    # Filter for both DOCX and Excel files
    supported_mimetypes = [
        'application/vnd.google-apps.document',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.google-apps.spreadsheet',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ]
    
    meta_df = df[df['mimeType'].isin(supported_mimetypes)]
    file_ids = meta_df["id"].tolist()
    meta_map = meta_df.set_index("id").to_dict(orient="index")

    print(f"[Info] Found {len(file_ids)} files to process:")
    mime_counts = meta_df['mimeType'].value_counts()
    for mime_type, count in mime_counts.items():
        print(f"  - {mime_type}: {count} files")

    data, failed = extract_data(file_ids)

    print(f"\n[Final Summary]")
    print(f"Total files in index: {len(file_ids)}")
    print(f"Already processed (skipped): {len(already_processed)}")
    print(f"Newly processed: {len(data['doc_id']) - len(already_processed) if len(data['doc_id']) >= len(already_processed) else len(data['doc_id'])}")
    print(f"Total in backup now: {len(data['doc_id'])}")
    if failed:
        print(f"Failed to process: {len(failed)} files")
        for fid in failed:
            file_name = meta_map.get(fid, {}).get("name", "Unknown")
            print(f"  - {fid} ({file_name})")
    
    print(f"Total chunks generated: {sum(len(chunks) for chunks in data['chunks'])}")
    print(f"Backup saved to: {backup_path}")