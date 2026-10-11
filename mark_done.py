import os
import json

REPO_PATH = r"C:\Users\Baatman\Desktop\nitish code\Cool Project"
STATE_FILE_PATH = os.path.join(REPO_PATH, "hacktime_state.json")

valid_extensions = {'.py', '.js', '.ts', '.html', '.css', '.md', '.json', '.jsx', '.tsx'}
ignore_set = {'.git', '__pycache__', 'node_modules', 'venv', '.env', 'dist', 'build', 'hacktime.py', 'hacktime_state.json', 'mark_done.py'}

# Load tempfiles.txt ignores
tempfiles_path = os.path.join(REPO_PATH, 'tempfiles.txt')
if os.path.exists(tempfiles_path):
    try:
        with open(tempfiles_path, 'r', encoding='utf-8') as f:
            for line in f:
                cleaned = line.strip()
                if cleaned and not cleaned.startswith('#'):
                    ignore_set.add(cleaned)
    except Exception:
        pass

processed_files = {}

for root, dirs, files in os.walk(REPO_PATH):
    # Filter out ignored directories
    dirs[:] = [d for d in dirs if d not in ignore_set and os.path.relpath(os.path.join(root, d), REPO_PATH).split(os.sep)[0] not in ignore_set]
    
    for file in files:
        filepath = os.path.join(root, file)
        rel_path = os.path.relpath(filepath, REPO_PATH)
        
        if file in ignore_set or rel_path in ignore_set:
            continue
            
        ext = os.path.splitext(file)[1].lower()
        if ext in valid_extensions:
            try:
                mtime = os.path.getmtime(filepath)
                processed_files[filepath] = mtime
            except OSError:
                continue

state = {"processed_files": processed_files}
with open(STATE_FILE_PATH, 'w', encoding='utf-8') as f:
    json.dump(state, f, indent=2)

print(f"Success! Marked {len(processed_files)} files as processed in hacktime_state.json.")