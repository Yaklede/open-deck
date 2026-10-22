#!/usr/bin/env python3
"""Build-time only. Sends fixed public source UI strings, never runtime/user data.
Runtime apps load committed catalogs and make no translation-service requests.
"""
import concurrent.futures,json,pathlib,re,ssl,time,urllib.parse,urllib.request,xml.etree.ElementTree as ET,threading
ROOT=pathlib.Path(__file__).resolve().parents[2]
OUT=ROOT/'host/public/locales'
REF=ROOT.parent/'work/macro-deck/source'
LANGUAGES={'ar':'العربية','pt-BR':'Português (Brasil)','cs':'Čeština','nl':'Nederlands','en':'English','fr':'Français','de':'Deutsch','hi':'हिन्दी','id':'Bahasa Indonesia','it':'Italiano','ja':'日本語','ko':'한국어','pl':'Polski','ru':'Русский','zh':'简体中文','es':'Español','zh-TW':'繁體中文','tr':'Türkçe','uk':'Українська'}
SOURCES=json.loads((OUT/'public-translation-sources.json').read_text())
CTX=ssl.create_default_context(cafile='/etc/ssl/cert.pem')
LOCK=threading.Lock()
REUSE={lang:{} for lang in LANGUAGES}
for kop in REF.rglob('*.ko.resx'):
 try: ko={x.get('name'):x.findtext('value') for x in ET.parse(kop).getroot().findall('data')}
 except Exception:continue
 for lang in LANGUAGES:
  p=kop.with_name(kop.name.replace('.ko.resx',('.resx' if lang=='en' else f'.{lang}.resx')))
  if not p.exists():continue
  try: target={x.get('name'):x.findtext('value') for x in ET.parse(p).getroot().findall('data')}
  except Exception:continue
  for k,v in ko.items():
   if v and target.get(k):REUSE[lang][v.strip()]=target[k].strip()

def translate_batch(lang,items):
 # Markers provide strict one-to-one boundaries; braces and printf placeholders stay exact.
 protected=[]; originals={}
 for i,source in enumerate(items):
  def protect(m):
   key=f'ZXQVAR{len(originals):05d}QXZ';originals[key]=m[0];return key
  text=re.sub(r'\{\{[^{}]+\}\}|\{\d+\}|%[,.0-9]*[dfs]',protect,source.strip())
  protected.append(f'⟪OD{i:05d}⟫\n{text}\n')
 q='\n'.join(protected)+'\n⟪OD99999⟫'
 params=urllib.parse.urlencode({'client':'dict-chrome-ex','sl':'ko','tl':{'zh':'zh-CN'}.get(lang,lang),'dt':'t','q':q})
 last=None
 for attempt in range(7):
  try:
   req=urllib.request.Request('https://translate.google.com/translate_a/single?'+params,headers={'User-Agent':'Mozilla/5.0'})
   with urllib.request.urlopen(req,context=CTX,timeout=45) as response: data=json.load(response)
   translated=''.join(x[0] or '' for x in data[0])
   marks=list(re.finditer(r'⟪\s*OD\s*(\d{5})\s*⟫',translated))
   if len(marks)!=len(items)+1:raise ValueError('Translation markers changed')
   result={}
   for i,source in enumerate(items):
    if int(marks[i][1])!=i:raise ValueError('Translation order changed')
    value=translated[marks[i].end():marks[i+1].start()].strip()
    for key,original in originals.items():value=value.replace(key,original)
    if re.search('ZXQVAR|QXZ',value):raise ValueError('Placeholder changed')
    expected=re.findall(r'\{\{[^{}]+\}\}|\{\d+\}|%[,.0-9]*[dfs]',source)
    actual=re.findall(r'\{\{[^{}]+\}\}|\{\d+\}|%[,.0-9]*[dfs]',value)
    if sorted(expected)!=sorted(actual):raise ValueError('Placeholder not preserved')
    prefix=re.match(r'^\s*',source)[0];suffix=re.search(r'\s*$',source)[0]
    result[source]=prefix+value+suffix
   return result
  except Exception as e:
   last=e;time.sleep(min(30,2**attempt))
 raise last

def build(lang):
 p=OUT/f'{lang}.json';catalog=json.loads(p.read_text()) if p.exists() else {}
 provenance={'reference':0,'source':0,'translated':0}
 for entry in SOURCES:
  source=entry['source']
  if lang=='ko':catalog[source]=source;provenance['source']+=1
  elif lang=='en' and entry.get('english'):catalog[source]=entry['english'];provenance['source']+=1
  elif source.strip() in REUSE[lang]:
   catalog[source]=re.match(r'^\s*',source)[0]+REUSE[lang][source.strip()]+re.search(r'\s*$',source)[0];provenance['reference']+=1
 pending=[x['source'] for x in SOURCES if x['source'] not in catalog]
 batches=[];batch=[];length=0
 for source in pending:
  size=len(source.encode())+40
  if batch and length+size>3200:batches.append(batch);batch=[];length=0
  batch.append(source);length+=size
 if batch:batches.append(batch)
 for i,batch in enumerate(batches):
  try:result=translate_batch(lang,batch)
  except Exception:
   # Individual retry isolates unusual markup without dropping strings.
   result={}
   for source in batch:result.update(translate_batch(lang,[source]))
  catalog.update(result);provenance['translated']+=len(result)
  p.write_text(json.dumps(catalog,ensure_ascii=False,indent=2)+'\n')
  with LOCK:print(f'{lang}: {i+1}/{len(batches)} batches, {len(catalog)}/{len(SOURCES)} strings',flush=True)
  time.sleep(.15)
 p.write_text(json.dumps(catalog,ensure_ascii=False,indent=2)+'\n')
 return lang,provenance

if __name__=='__main__':
 import sys
 selected=sys.argv[1:] or list(LANGUAGES)
 (OUT/'languages.json').write_text(json.dumps([{'code':k,'name':v}for k,v in LANGUAGES.items()],ensure_ascii=False,indent=2)+'\n')
 with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
  for lang,provenance in pool.map(build,selected):print('COMPLETE',lang,provenance,flush=True)
