import os
import pickle
import pandas as pd
from dotenv import load_dotenv
from pinecone import Pinecone as PineconeClient, ServerlessSpec
from langchain_openai import OpenAIEmbeddings

# =========================
# ENV & CONFIG
# =========================
load_dotenv()
PINECONE_API_KEY = os.getenv("PINECONE_API_KEY")
OPENAI_API_KEY   = os.getenv("OPENAI_API_KEY")

EMBED_MODEL   = "text-embedding-ada-002"
DIMENSION     = 1536
REGION        = "us-east-1"
CLOUD         = "aws"

IDX_QUESTIONS = "my-doc-questions-private"
IDX_SUMMARIES = "my-doc-summaries-private"
IDX_CHUNKS    = "my-doc-chunks-private"

QUESTIONS_BACKUP  = "questions_backup_2025.pkl"
SUMMARIES_BACKUP  = "summaries_backup_2025.pkl"
FILES_CSV         = "files_0AGhLXRXVGCy1Uk9PVA.csv"

BATCH_EMB    = 128   # embedding batch size
BATCH_UPSERT = 200   # pinecone upsert batch size
MAX_DOC_BYTES = 3_500_000  # safety margin under Pinecone ~4MB record limit


# =========================
# HELPERS
# =========================
def ensure_index(pc, name: str, dimension: int, metric: str = "cosine"):
    existing = [i.name for i in pc.list_indexes()]
    if name not in existing:
        pc.create_index(
            name=name,
            dimension=dimension,
            metric=metric,
            spec=ServerlessSpec(cloud=CLOUD, region=REGION),
        )
        print(f"[Create] Index '{name}' created.")
    else:
        print(f"[OK] Index '{name}' exists.")

def chunked(xs, n):
    buf = []
    for x in xs:
        buf.append(x)
        if len(buf) >= n:
            yield buf
            buf = []
    if buf:
        yield buf

def pick_first_column(df: pd.DataFrame, candidates: list[str]) -> str | None:
    for c in candidates:
        if c in df.columns:
            return c
    return None

def as_opt_str(v):
    if v is None:
        return None
    try:
        if pd.isna(v):
            return None
    except Exception:
        pass
    return str(v)

def chunk_text(obj) -> str:
    # chunk may be a string or a LangChain Document-like object
    if isinstance(obj, str):
        return obj
    if hasattr(obj, "page_content"):
        return obj.page_content
    if hasattr(obj, "content"):
        return obj.content
    return str(obj)


# =========================
# LOAD BACKUPS
# =========================
with open(QUESTIONS_BACKUP, "rb") as f:
    q_data = pickle.load(f)
print(f"[Load] Questions backup: {len(q_data['doc_id'])} docs")

with open(SUMMARIES_BACKUP, "rb") as f:
    s_data = pickle.load(f)
print(f"[Load] Summaries backup: {len(s_data['doc_id'])} docs (chunks present: {'chunks' in s_data})")

# =========================
# LOAD FILE METADATA
# =========================
files_df = pd.read_csv(FILES_CSV)

id_col       = pick_first_column(files_df, ["id", "file_id", "doc_id"])
name_col     = pick_first_column(files_df, ["name", "filename", "file_name", "title"])
mime_col     = pick_first_column(files_df, ["mimeType", "mime_type"])
owners_col   = pick_first_column(files_df, ["owners", "owner", "owner_emails"])
created_col  = pick_first_column(files_df, ["created_at", "createdTime", "created_at_utc", "created"])
modified_col = pick_first_column(files_df, ["modified_at", "modifiedTime", "modified_at_utc", "modified"])
year_col     = pick_first_column(files_df, ["year", "Year"])
url_col      = pick_first_column(files_df, ["url", "URL", "drive_url", "google_drive_url"])

required = [id_col]
if not all(required):
    raise ValueError("[Error] files_index.csv must have an 'id' column (or equivalent).")

# Build a flexible meta_map keyed by doc_id
meta_map = {}
for _, row in files_df.iterrows():
    k = row[id_col]
    meta_map[k] = {
        "name":        as_opt_str(row[name_col])      if name_col      else None,
        "mimeType":    as_opt_str(row[mime_col])      if mime_col      else None,
        "owners":      as_opt_str(row[owners_col])    if owners_col    else None,
        "created_at":  as_opt_str(row[created_col])   if created_col   else None,
        "modified_at": as_opt_str(row[modified_col])  if modified_col  else None,
        "year":        as_opt_str(row[year_col])      if year_col      else None,
        "url":         as_opt_str(row[url_col])       if url_col       else None,
    }

# =========================
# PINECONE + EMBEDDINGS
# =========================
pc = PineconeClient(api_key=PINECONE_API_KEY)
ensure_index(pc, IDX_QUESTIONS, DIMENSION)
ensure_index(pc, IDX_SUMMARIES, DIMENSION)
ensure_index(pc, IDX_CHUNKS, DIMENSION)

idx_questions = pc.Index(IDX_QUESTIONS)
idx_summaries = pc.Index(IDX_SUMMARIES)
idx_chunks    = pc.Index(IDX_CHUNKS)

embedder = OpenAIEmbeddings(model=EMBED_MODEL, api_key=OPENAI_API_KEY)


# =========================
# INDEX: QUESTIONS
# =========================
print("\n[Stage] Indexing questions…")
q_texts, q_records = [], []
q_uploaded, q_skipped = 0, 0

for doc_id, questions in zip(q_data["doc_id"], q_data["questions"]):
    clean = [q.strip() for q in questions if isinstance(q, str) and q.strip()]
    if not clean:
        q_skipped += 1
        print(f"[Skip][Q] {doc_id}: no valid questions")
        continue

    joined = "\n".join(clean)
    if len(joined.encode("utf-8")) > MAX_DOC_BYTES:
        q_skipped += 1
        print(f"[Skip][Q] {doc_id}: questions metadata too large ({len(joined.encode('utf-8'))} bytes)")
        continue

    base = meta_map.get(doc_id, {})
    meta = {
        "doc_id": doc_id,
        "doc_type": "question_list",
        "num_questions": len(clean),
        "questions_text": joined,
        "name": base.get("name"),
        "mimeType": base.get("mimeType"),
        "owners": base.get("owners"),
        "created_at": base.get("created_at"),
        "modified_at": base.get("modified_at"),
        "year": base.get("year"),
        "url": base.get("url"),
    }
    q_texts.append(joined)
    q_records.append({
        "id": f"{doc_id}::questions",
        "values": None,
        "metadata": {k: v for k, v in meta.items() if v is not None},
    })

# embed & upsert (questions)
for batch_i, batch in enumerate(chunked(list(zip(q_texts, q_records)), BATCH_EMB), start=1):
    texts = [t for t, _ in batch]
    vecs = embedder.embed_documents(texts)
    for (_, rec), vec in zip(batch, vecs):
        rec["values"] = vec

for batch_i, batch in enumerate(chunked(q_records, BATCH_UPSERT), start=1):
    idx_questions.upsert(vectors=batch)
    q_uploaded += len(batch)
    if batch_i % 10 == 0 or len(batch) < BATCH_UPSERT:
        print(f"[Upsert][Q] batch {batch_i}: +{len(batch)} (total {q_uploaded})")

print(f"[Done][Q] uploaded {q_uploaded}, skipped {q_skipped}")


# =========================
# INDEX: SUMMARIES (includes text)
# =========================
print("\n[Stage] Indexing summaries…")
s_texts, s_records = [], []
s_uploaded, s_skipped = 0, 0

for doc_id, summary in zip(s_data["doc_id"], s_data["summary"]):
    text = (summary or "").strip()
    if not text:
        s_skipped += 1
        print(f"[Skip][S] {doc_id}: empty summary")
        continue

    if len(text.encode("utf-8")) > MAX_DOC_BYTES:
        s_skipped += 1
        print(f"[Skip][S] {doc_id}: summary text too large ({len(text.encode('utf-8'))} bytes)")
        continue

    base = meta_map.get(doc_id, {})
    meta = {
        "doc_type": "summary",
        "id": doc_id,  # keep original id in metadata as shown in your examples
        "name": base.get("name"),
        "mimeType": base.get("mimeType"),
        "owners": base.get("owners"),
        "created_at": base.get("created_at"),
        "modified_at": base.get("modified_at"),
        "year": base.get("year"),
        "url": base.get("url"),  # Add Google Drive URL
        "text": text,  # <<< include summary text
    }

    s_texts.append(text)
    s_records.append({
        "id": f"{doc_id}::summary",
        "values": None,
        "metadata": {k: v for k, v in meta.items() if v is not None},
    })

# embed & upsert (summaries)
for batch_i, batch in enumerate(chunked(list(zip(s_texts, s_records)), BATCH_EMB), start=1):
    texts = [t for t, _ in batch]
    vecs = embedder.embed_documents(texts)
    for (_, rec), vec in zip(batch, vecs):
        rec["values"] = vec

for batch_i, batch in enumerate(chunked(s_records, BATCH_UPSERT), start=1):
    idx_summaries.upsert(vectors=batch)
    s_uploaded += len(batch)
    if batch_i % 10 == 0 or len(batch) < BATCH_UPSERT:
        print(f"[Upsert][S] batch {batch_i}: +{len(batch)} (total {s_uploaded})")

print(f"[Done][S] uploaded {s_uploaded}, skipped {s_skipped}")


# =========================
# INDEX: CHUNKS (includes text)
# =========================
print("\n[Stage] Indexing chunks…")
if "chunks" not in s_data:
    print("[Warn] 'chunks' missing in summaries backup; skipping chunks.")
else:
    c_texts, c_records = [], []
    c_uploaded, c_skipped = 0, 0

    for doc_id, chunks in zip(s_data["doc_id"], s_data["chunks"]):
        base = meta_map.get(doc_id, {})
        for i, ch in enumerate(chunks):
            content = chunk_text(ch).strip()
            if not content:
                c_skipped += 1
                print(f"[Skip][C] {doc_id}[{i}]: empty content")
                continue

            if len(content.encode("utf-8")) > MAX_DOC_BYTES:
                c_skipped += 1
                print(f"[Skip][C] {doc_id}[{i}]: chunk text too large ({len(content.encode('utf-8'))} bytes)")
                continue

            meta = {
                "doc_type": "chunk",
                "id": doc_id,            # original file id in metadata
                "chunk_index": i,
                "name": base.get("name"),
                "mimeType": base.get("mimeType"),
                "owners": base.get("owners"),
                "created_at": base.get("created_at"),
                "modified_at": base.get("modified_at"),
                "year": base.get("year"),
                "url": base.get("url"),
                "text": content,         # <<< include chunk text
            }

            c_texts.append(content)
            c_records.append({
                "id": f"{doc_id}::chunk::{i}",
                "values": None,
                "metadata": {k: v for k, v in meta.items() if v is not None},
            })

    # embed & upsert (chunks)
    for batch_i, batch in enumerate(chunked(list(zip(c_texts, c_records)), BATCH_EMB), start=1):
        texts = [t for t, _ in batch]
        vecs = embedder.embed_documents(texts)
        for (_, rec), vec in zip(batch, vecs):
            rec["values"] = vec

    for batch_i, batch in enumerate(chunked(c_records, BATCH_UPSERT), start=1):
        idx_chunks.upsert(vectors=batch)
        c_uploaded += len(batch)
        if batch_i % 10 == 0 or len(batch) < BATCH_UPSERT:
            print(f"[Upsert][C] batch {batch_i}: +{len(batch)} (total {c_uploaded})")

    print(f"[Done][C] uploaded {c_uploaded}, skipped {c_skipped}")

print("\n[All Done] Indexed to:")
print(f" - {IDX_QUESTIONS}")
print(f" - {IDX_SUMMARIES}")
print(f" - {IDX_CHUNKS}")