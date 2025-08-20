from googleapiclient.discovery import build
from google.oauth2.credentials import Credentials
from typing import Any, List, Dict, Union
import pandas as pd
from python_draft.settings import drive_folders, ALLOWED_TYPES, SKIP_FOLDER_ID

def fetch_files_recursive(
    service: Any,
    folder_id: str
) -> List[Dict[str, Union[str, List[str]]]]:

    results: List[Dict[str, Union[str, List[str]]]] = []
    page_token = None

    while True:
        resp = service.files().list(
            q=f"'{folder_id}' in parents and trashed = false",
            pageSize=1000,
            includeItemsFromAllDrives=True,
            supportsAllDrives=True,
            fields=(
                "nextPageToken,"
                "files("
                  "id,"
                  "name,"
                  "mimeType,"
                  "parents,"
                  "trashed,"
                  "createdTime,"
                  "modifiedTime,"
                  "webViewLink,"
                  "owners(emailAddress)"
                ")"
            ),
            pageToken=page_token
        ).execute()

        for f in resp.get("files", []):
            # 1) Skip that folder entirely:
            if f["id"] == SKIP_FOLDER_ID:
                continue

            if f["mimeType"] == "application/vnd.google-apps.folder":
                # recurse into subfolders (unless it's the skip one)
                results.extend(fetch_files_recursive(service, f["id"]))
            elif f["mimeType"] in ALLOWED_TYPES:
                results.append({
                    "id":           f["id"],
                    "name":         f["name"],
                    "mimeType":     f["mimeType"],
                    "parents":      f.get("parents", []),
                    "trashed":      f.get("trashed", False),
                    "created_at":   f.get("createdTime"),
                    "modified_at":  f.get("modifiedTime"),
                    "url":          f.get("webViewLink"),
                    "owners":       [o["emailAddress"] for o in f.get("owners", [])],
                })

        page_token = resp.get("nextPageToken")
        if not page_token:
            break

    return results


def get_extension(file):
    temp = file['name'].split('.')[-1]
    if temp in {'docx', 'xlsx', 'pptx', 'pdf'}:
        return file['name'].split('/')[-1]
    
    mime_to_ext = {
        'application/vnd.google-apps.document': 'docx',        
        'application/vnd.google-apps.spreadsheet': 'xlsx',      
        'application/vnd.google-apps.presentation': 'pptx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx', 
        'application/pdf': 'pdf'
    }
    return  file['name'].split('/')[-1] + "." + mime_to_ext[file['mimeType']]

if __name__ == "__main__":
    token_path = "token.json"
    scopes = ["https://www.googleapis.com/auth/drive.readonly"]
    creds = Credentials.from_authorized_user_file(
        str(token_path), scopes
    )

    service = build("drive", "v3", credentials=creds)

    folder = '0AGhLXRXVGCy1Uk9PVA'
    files = fetch_files_recursive(service, folder)
    print(f"extracted {len(files)} files for {folder}")
    df = pd.DataFrame(files.copy())
    df['name'] = df.apply(get_extension, axis=1)
    df['year'] = folder
    df.to_csv(f"files_{folder}.csv", index=False)
