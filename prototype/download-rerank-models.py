"""Explicit, pinned public model download. No remote code or credentials."""
import concurrent.futures,json,subprocess,hashlib
from pathlib import Path
ROOT=Path(__file__).parent
models={
 'mmarco':('cross-encoder/mmarco-mMiniLMv2-L12-H384-v1','1427fd652930e4ba29e8149678df786c240d8825', ['onnx/model.onnx','tokenizer.json','tokenizer_config.json','config.json','special_tokens_map.json']),
 'qwen':('Qwen/Qwen3-Reranker-0.6B','e61197ed45024b0ed8a2d74b80b4d909f1255473',['model.safetensors','config.json','tokenizer.json','tokenizer_config.json','vocab.json','merges.txt']),
}
def get(item):
 name,repo,revision,file=item
 target=ROOT/'models'/name/file;target.parent.mkdir(parents=True,exist_ok=True)
 url=f'https://huggingface.co/{repo}/resolve/{revision}/{file}'
 subprocess.run(['curl','-sSL','--fail','--max-time','600','--retry','1','-C','-','-o',str(target),url],check=True)
 digest=hashlib.sha256()
 with target.open('rb') as stream:
  for chunk in iter(lambda:stream.read(8*1024*1024),b''):digest.update(chunk)
 print(name,file,target.stat().st_size,flush=True)
 return {'model':name,'file':file,'bytes':target.stat().st_size,'sha256':digest.hexdigest(),'url':url}
if __name__=='__main__':
 tasks=[(name,repo,rev,file) for name,(repo,rev,files) in models.items() for file in files]
 with concurrent.futures.ThreadPoolExecutor(3) as pool: files=list(pool.map(get,tasks))
 (ROOT/'rerank-model-manifest.json').write_text(json.dumps({'models':{name:{'repository':repo,'revision':rev,'license':'Apache-2.0'} for name,(repo,rev,_) in models.items()},'files':files},indent=2)+'\n')
