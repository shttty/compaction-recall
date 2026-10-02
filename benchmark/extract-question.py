"""Extract one official JSON record from a byte range; does not download the full dataset.
Run --help for the explicit source byte range and new external output directory.
Ranges are inclusive. Inspect result and adjust the range if the record spans its edges.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import argparse

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--start', type=int, required=True)
parser.add_argument('--end', type=int, required=True)
parser.add_argument('--question', required=True)
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
if args.start < 0 or args.end < args.start:
    parser.error('Invalid inclusive byte range')
root = args.output_dir
root.mkdir(parents=True, exist_ok=False)
start, end, qid = args.start, args.end, args.question
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
