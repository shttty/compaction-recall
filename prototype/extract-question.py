"""Extract one official JSON record from a byte range; does not download the full dataset.
Usage: python3 prototype/extract-question.py START END [QUESTION_ID]
Ranges are inclusive. Inspect result and adjust the range if the record spans its edges.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

root = Path(__file__).parent
start, end = map(int, sys.argv[1:3])
qid = sys.argv[3] if len(sys.argv) > 3 else '577d4d32'
url = 'https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_m'
archive = root / 'range.download'
subprocess.run(['curl', '-sSL', '--fail', '--max-time', '90', '-r', f'{start}-{end}',
                '-D', str(root / 'range.headers'), '-o', str(archive), url], check=True)
raw = archive.read_bytes()
needle = f'"question_id": "{qid}"'.encode()
at = raw.find(needle)
if at < 0:
    raise SystemExit('Question not present in selected range; no synthetic fallback created')
begin = raw.rfind(b'{', 0, at)
# The range may start/end inside another UTF-8 record; decode only the selected object's suffix.
q, length = json.JSONDecoder().raw_decode(raw[begin:].decode('utf8', errors='replace'))
assert q['question_id'] == qid
out = root / 'selected.download.json'
out.write_text(json.dumps(q, ensure_ascii=False))
provenance = {'source': url, 'dataset': 'original LongMemEval_M (not cleaned, S, or oracle)',
              'questionId': qid, 'rangeStart': start, 'rangeEnd': end,
              'recordByteStart': start + begin, 'extractedSha256': hashlib.sha256(out.read_bytes()).hexdigest(),
              'sessions': len(q['haystack_sessions'])}
(root / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
print(json.dumps(provenance, indent=2))
