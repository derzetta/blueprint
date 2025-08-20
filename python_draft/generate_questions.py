import os
import sys
import pickle
import pandas as pd
from tqdm import tqdm
from typing import List
from dotenv import load_dotenv
from langchain_openai import ChatOpenAI

# ——— Load environment variables ———
load_dotenv()

# ——— Config & Globals ———
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
summaries_backup_path = "summaries_backup_2025.pkl"
questions_backup_path = "questions_backup_2025.pkl"
files_index_path = "files_0AGhLXRXVGCy1Uk9PVA.csv"   # <—— CSV with name/year
backup_every = 20

llm = ChatOpenAI(model="gpt-3.5-turbo", temperature=0, api_key=OPENAI_API_KEY)

# ——— Load existing questions backup if it exists ———
if os.path.exists(questions_backup_path):
    with open(questions_backup_path, "rb") as f:
        questions_out = pickle.load(f)
    if isinstance(questions_out, dict) and "chunks" in questions_out:
        questions_out.pop("chunks", None)
    print(f"[Resume] Loaded questions backup with {len(questions_out.get('doc_id', []))} documents.")
else:
    questions_out = {"doc_id": [], "questions": []}
    print("[Start] No questions backup found. Starting from scratch.")

already_processed_questions = set(questions_out["doc_id"])

# ——— Load summaries backup ———
if not os.path.exists(summaries_backup_path):
    print(f"[Error] Summaries backup not found at {summaries_backup_path}")
    sys.exit(1)

with open(summaries_backup_path, "rb") as f:
    summaries_data = pickle.load(f)

print(f"[Info] Loaded summaries for {len(summaries_data['doc_id'])} documents.")

# ——— Load file metadata (file_name, year) ———
if not os.path.exists(files_index_path):
    print(f"[Error] files_index.csv not found at {files_index_path}")
    sys.exit(1)

files_df = pd.read_csv(files_index_path)
# Expecting columns: id, name, year
if not {"id", "name", "year"}.issubset(files_df.columns):
    print("[Error] files_index.csv must contain columns: id, name, year")
    sys.exit(1)

meta_map = files_df.set_index("id")[["name", "year"]].to_dict(orient="index")
print(f"[Info] Loaded metadata for {len(meta_map)} files from {files_index_path}")

# ——— Question Generation ———
def generate_questions_from_summary(summary: str, file_name: str = None, year: str = None, n: int = 10) -> List[str]:
    context = f"File: {file_name} (Year: {year})\n" if (file_name and year) else ""

    prompt = (
        f"This is a summary of a document from Aaltoes (startup support, events, partnerships, board, funding, or deep tech initiatives).\n"
        f"{context}\n"
        f"Based on the summary below, generate {n} specific search questions that someone would ask when looking for this document.\n"
        f"Focus on what users would search for to FIND this document.\n\n"
        f"SUMMARY:\n{summary}\n\n"
        f"Generate questions that someone would ask when searching for:\n"
        f"- Specific data or metrics they need\n"
        f"- Information about events, partnerships, or initiatives\n"
        f"- Financial data, budgets, or funding information\n"
        f"- Member lists, contact information, or organizational data\n"
        f"- Performance metrics or analytics\n"
        f"- Historical data or trend information\n"
        f"- Strategic plans or operational details\n\n"
        f"Make the questions natural search queries that would help users discover this document.\n"
        f"QUESTIONS:"
    )
    try:
        response = llm.invoke(prompt)
        raw_lines = response.content.splitlines()
        questions = [q.strip().lstrip("-•0123456789. ").strip() for q in raw_lines if q.strip()]
        questions = list(dict.fromkeys([q for q in questions if len(q) > 10]))[:n]
        return questions
    except Exception as e:
        print(f"[Error generating questions] {e}")
        return []

# ——— Main processing function ———
def generate_all_questions():
    processed_count, failed_count, skipped_count = 0, 0, 0
    total_docs = len(summaries_data['doc_id'])

    print(f"[Info] Starting processing of {total_docs} documents")
    print(f"[Info] Already processed: {len(already_processed_questions)} documents will be skipped")

    for i in tqdm(range(total_docs), desc="Generating questions"):
        doc_id = summaries_data['doc_id'][i]

        # Skip if already processed
        if doc_id in already_processed_questions:
            skipped_count += 1
            continue

        try:
            summary = summaries_data['summary'][i]
            file_name, year = "Unknown", "Unknown"
            if doc_id in meta_map:
                file_name = meta_map[doc_id].get("name", "Unknown")
                year = meta_map[doc_id].get("year", "Unknown")

            questions = []
            if summary and len(summary.strip()) > 20:
                questions = generate_questions_from_summary(summary, file_name, year)

            if questions:
                questions_out["doc_id"].append(doc_id)
                questions_out["questions"].append(questions)
                processed_count += 1
                print(f"\n{'='*60}")
                print(f"PROCESSED {processed_count}: {file_name} (Year: {year})")
                print(f"Doc ID: {doc_id}")
                for j, q in enumerate(questions, 1):
                    print(f"  {j}. {q}")
                print(f"{'='*60}")
            else:
                print(f"[Warning] No questions generated for {doc_id}")
                failed_count += 1

        except Exception as e:
            print(f"[Error] Processing {doc_id}: {e}")
            failed_count += 1

        # Periodic backup
        if processed_count > 0 and processed_count % backup_every == 0:
            with open(questions_backup_path, "wb") as f:
                pickle.dump(questions_out, f, protocol=pickle.HIGHEST_PROTOCOL)
            print(f"\n[Backup] Saved after {processed_count} processed documents")

    # Final backup
    with open(questions_backup_path, "wb") as f:
        pickle.dump(questions_out, f, protocol=pickle.HIGHEST_PROTOCOL)
    print(f"\n[Done] Final backup saved to {questions_backup_path}")

    return processed_count, failed_count, skipped_count

# ——— Entry Point ———
if __name__ == "__main__":
    print(f"[Info] Reading summaries from: {summaries_backup_path}")
    print(f"[Info] Reading file metadata from: {files_index_path}")
    processed, failed, skipped = generate_all_questions()

    print(f"\n[Final Summary]")
    print(f"Total documents: {len(summaries_data['doc_id'])}")
    print(f"Skipped: {skipped}")
    print(f"Processed: {processed}")
    print(f"Failed: {failed}")
    print(f"Total in backup now: {len(questions_out['doc_id'])}")
    print(f"Total questions: {sum(len(q) for q in questions_out['questions'])}")
    print(f"Results saved to: {questions_backup_path}")
