"""Select DEV8 + first two additional single-session-user records from verified full M."""
import hashlib
import json
from pathlib import Path
import sys

source = Path(sys.argv[1])
ids = ['577d4d32', '778164c6', '51b23612', 'ceb54acb', '3d86fd0a', '15745da0', 'gpt4_65aabe59', '982b5123']
selected, extras = {}, []
decoder = json.JSONDecoder()
with source.open(encoding='utf8') as stream:
    buffer = stream.read(8 * 1024 * 1024).lstrip()[1:]
    while True:
        buffer = buffer.lstrip()
        if buffer.startswith(']'): break
        while True:
            try: q, end = decoder.raw_decode(buffer); break
            except json.JSONDecodeError:
                chunk = stream.read(8 * 1024 * 1024)
                if not chunk: raise
                buffer += chunk
        qid = q['question_id']
        if qid in ids: selected[qid] = q
        elif q['question_type'] == 'single-session-user' and len(extras) < 2:
            extras.append(qid); selected[qid] = q
        buffer = buffer[end:].lstrip()
        while not buffer: buffer += stream.read(8 * 1024 * 1024); buffer = buffer.lstrip()
        if buffer.startswith(','): buffer = buffer[1:]
        if len(selected) == 10: break
assert len(selected) == 10
out = Path(__file__).parent / 'stacked.download.json'
records = [selected[qid] for qid in ids + extras]
out.write_text(json.dumps(records, ensure_ascii=False))
manifest = {'source': str(source), 'selection': 'DEV8 in listed order, plus first two additional single-session-user records in original full-M file order',
            'questionIds': ids + extras, 'inputSha256': hashlib.sha256(out.read_bytes()).hexdigest(),
            'questions': [{'id': q['question_id'], 'type': q['question_type'], 'question': q['question'], 'sessions': len(q['haystack_sessions'])} for q in records]}
(Path(__file__).parent / 'stacked-provenance.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(manifest, ensure_ascii=False, indent=2))
