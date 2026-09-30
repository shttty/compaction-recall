"""Verify the complete official LongMemEval_M download without loading 2.75 GB into RAM."""
import hashlib
import json
import os
from pathlib import Path
import sys

part = Path(sys.argv[1])
expected_size = 2745274681
expected_sha = 'fb5413e3b077c62927daab794836991a2fcfa61ceacab57dc679fb02daaff2d9'
assert part.stat().st_size == expected_size, 'Official byte length mismatch'
hash_ = hashlib.sha256()
with part.open('rb') as stream:
    for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b''): hash_.update(chunk)
assert hash_.hexdigest() == expected_sha, 'Official SHA-256 mismatch'
# Strictly parse each complete top-level object, retaining at most one question + a small input buffer.
count, ids, selected = 0, set(), None
decoder = json.JSONDecoder()
with part.open(encoding='utf8') as stream:
    buffer = stream.read(8 * 1024 * 1024).lstrip()
    assert buffer.startswith('[')
    buffer = buffer[1:]
    while True:
        buffer = buffer.lstrip()
        if buffer.startswith(']'):
            assert not (buffer[1:] + stream.read()).strip(), 'Trailing data'
            break
        while True:
            try:
                record, end = decoder.raw_decode(buffer)
                break
            except json.JSONDecodeError:
                chunk = stream.read(8 * 1024 * 1024)
                if not chunk: raise
                buffer += chunk
        assert isinstance(record, dict) and 'question_id' in record and 'haystack_sessions' in record
        assert record['question_id'] not in ids
        ids.add(record['question_id']); count += 1
        if record['question_id'] == '577d4d32':
            selected = hashlib.sha256(json.dumps(record, ensure_ascii=False).encode()).hexdigest()
        buffer = buffer[end:].lstrip()
        while not buffer:
            buffer += stream.read(8 * 1024 * 1024)
            assert buffer, 'Missing array close'
            buffer = buffer.lstrip()
        if buffer.startswith(','):
            buffer = buffer[1:]
            # Reject a trailing comma rather than accepting an invalid top-level array.
            while not buffer.strip(): buffer += stream.read(8 * 1024 * 1024)
            assert not buffer.lstrip().startswith(']')
        else:
            assert buffer.startswith(']'), 'Missing comma'
assert count == 500, f'Unexpected record count: {count}'
assert selected == '5d3aa710459df3692a934aad85fda36413d9fe68e3d75836c12164d5672b9a4c', 'Selected record differs from benchmark input'
final = part.with_suffix('') if part.suffix == '.part' else part
if final != part: os.replace(part, final)
result = {'path': str(final), 'bytes': expected_size, 'sha256': expected_sha,
          'records': count, 'uniqueQuestionIds': len(ids), 'selectedQuestionSha256': selected,
          'source': 'https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_m'}
final.with_suffix('.verified.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
