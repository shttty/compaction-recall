"""Local-only fixed-pool reranking; no answer generation, remote code, or gold labels."""
import argparse,json,time,resource,os,platform,hashlib
from pathlib import Path
P=Path(__file__).parent
parser=argparse.ArgumentParser();parser.add_argument('model',choices=['mmarco','qwen']);parser.add_argument('--pilot',action='store_true');a=parser.parse_args()
os.environ['HF_HUB_OFFLINE']='1';os.environ['TRANSFORMERS_OFFLINE']='1';os.environ['TOKENIZERS_PARALLELISM']='false'
start=time.perf_counter();baseline=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
if a.model=='mmarco':
 import numpy as np,onnxruntime as ort
 from tokenizers import Tokenizer
 ort.disable_telemetry_events()
 tok=Tokenizer.from_file(str(P/'models/mmarco/tokenizer.json'));tok.enable_truncation(max_length=512,strategy='longest_first');tok.enable_padding(pad_id=1,pad_token='<pad>')
 options=ort.SessionOptions();options.intra_op_num_threads=4;options.inter_op_num_threads=1
 model=ort.InferenceSession(str(P/'models/mmarco/onnx/model.onnx'),sess_options=options,providers=['CPUExecutionProvider'])
 inputs=[x.name for x in model.get_inputs()]
 def score(query,passages):
  encoded=tok.encode_batch([(query,text) for text in passages])
  values={'input_ids':np.array([x.ids for x in encoded],dtype=np.int64),'attention_mask':np.array([x.attention_mask for x in encoded],dtype=np.int64),'token_type_ids':np.array([x.type_ids for x in encoded],dtype=np.int64)}
  return model.run(None,{k:values[k] for k in inputs})[0].reshape(-1).astype(float).tolist(),[sum(x.attention_mask) for x in encoded]
 versions={'onnxruntime':ort.__version__};batchsize=4
else:
 import torch,transformers
 from transformers import AutoTokenizer,AutoModelForCausalLM
 torch.set_num_threads(4);torch.set_num_interop_threads(1)
 tok=AutoTokenizer.from_pretrained(str(P/'models/qwen'),local_files_only=True,trust_remote_code=False,padding_side='left')
 model=AutoModelForCausalLM.from_pretrained(str(P/'models/qwen'),local_files_only=True,trust_remote_code=False,dtype=torch.float32,attn_implementation='sdpa').eval()
 prefix='<|im_start|>system\nDetermine whether the document provides evidence relevant to the query and instruction. Respond only yes or no.<|im_end|>\n<|im_start|>user\n'
 suffix='<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n'
 before=tok.encode(prefix,add_special_tokens=False);after=tok.encode(suffix,add_special_tokens=False)
 yes=tok.convert_tokens_to_ids('yes');no=tok.convert_tokens_to_ids('no')
 def score(query,passages):
  texts=[f'<Instruct>: Find historical evidence that supports answering the user\'s question.\n<Query>: {query}\n<Document>: {p}' for p in passages]
  ids=tok(texts,add_special_tokens=False,truncation=True,max_length=512-len(before)-len(after))['input_ids']
  lens=[len(x)+len(before)+len(after) for x in ids]
  batch=tok.pad({'input_ids':[before+x+after for x in ids]},padding=True,return_tensors='pt')
  with torch.inference_mode(): logits=model(**batch,logits_to_keep=1).logits[:,-1,:]
  return (logits[:,yes]-logits[:,no]).float().tolist(),lens
 versions={'torch':torch.__version__,'transformers':transformers.__version__};batchsize=2
load_seconds=time.perf_counter()-start
sanity=[{'query':'我在哪里遇见小林？','documents':['我在市中心的咖啡馆遇见了小林。','服务器配置文件放在备份目录。'],'expected':0},
 {'query':'服务配置文件保存在哪里？','documents':['上周末我跑了五公里。','服务配置文件保存在 /opt/service/config.yaml。'],'expected':1},
 {'query':'周末跑步的距离是多少？','documents':['周末我跑了五公里，然后回家休息。','周末天气预报说可能下雨。'],'expected':0}]
for x in sanity:x['scores'],_=score(x['query'],x['documents']);x['top']=max(range(len(x['scores'])),key=x['scores'].__getitem__)
if a.pilot:
 payload={'model':a.model,'loadSeconds':load_seconds,'sanity':sanity,'peakRssMiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024,'versions':versions}
 print(json.dumps(payload,ensure_ascii=False,indent=2));raise SystemExit
raw=(P/'rerank-candidates.private.json').read_bytes();data=json.loads(raw);results=[]
for q in data['questions']:
 started=time.perf_counter();scores=[];lengths=[]
 for at in range(0,len(q['pool']),batchsize):
  values,lens=score(q['query'],[x['passage'] for x in q['pool'][at:at+batchsize]]);scores.extend(values);lengths.extend(lens)
 ranked=sorted(range(len(scores)),key=lambda i:(-scores[i],i))
 result={'id':q['id'],'seconds':time.perf_counter()-started,'scores':dict(zip([x['id'] for x in q['pool']],scores)),
  'orderedIds':[q['pool'][i]['id'] for i in ranked],'maxInputTokens':max(lengths,default=0),'cappedAt512':sum(x==512 for x in lengths)}
 results.append(result);print(a.model,q['id'],round(result['seconds'],3),'seconds',flush=True)
 payload={'model':a.model,'inputSha256':hashlib.sha256(raw).hexdigest(),'loadSeconds':load_seconds,'versions':versions,'threads':4,'batchSize':batchsize,'maxTokens':512,'precision':'float32','python':platform.python_version(),'baselineRssMiB':baseline/1024,'peakRssMiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024,'sanity':sanity,'results':results}
 (P/f'rerank-{a.model}-results.json').write_text(json.dumps(payload,ensure_ascii=False,indent=2)+'\n')
