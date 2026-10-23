#!/usr/bin/env python3
"""Merge checked-in translations; offline and safe to run during every release build."""
import json,pathlib,shutil,re
ROOT=pathlib.Path(__file__).resolve().parents[2];OUT=ROOT/'host/public/locales'
sources=json.loads((OUT/'sources.json').read_text());keys={x['source'] for x in sources}
languages=json.loads((OUT/'languages.json').read_text())
manual={}
for name in ['manual-reference.json','manual-security.json','manual-security-errors.json','manual-adb.json','manual-migration.json','manual-companion.json','manual-app.json','manual-final.json']:
 p=OUT/name
 if p.exists():
  for key,values in json.loads(p.read_text()).items():manual.setdefault(key,{}).update(values)
missing={};invalid=[]
for language in languages:
 code=language['code'];path=OUT/f'{code}.json';catalog=json.loads(path.read_text()) if path.exists() else {}
 for source in keys:
  if code=='ko':catalog[source]=source
  elif source in manual and code in manual[source]:catalog[source]=manual[source][code]
  if not catalog.get(source):missing.setdefault(source,[]).append(code)
  elif sorted(re.findall(r'\{\d+\}|%[,.0-9]*[dfs]',source))!=sorted(re.findall(r'\{\d+\}|%[,.0-9]*[dfs]',catalog[source])):invalid.append([code,source])
 path.write_text(json.dumps(catalog,ensure_ascii=False,indent=2)+'\n')
 asset=ROOT/'android/app/src/main/assets/locales'/path.name;asset.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(path,asset)
(OUT/'missing.json').write_text(json.dumps(missing,ensure_ascii=False,indent=2)+'\n')
print(f'{len(keys)} current UI keys, {len(languages)} languages, {len(missing)} missing keys, {len(invalid)} invalid placeholders')
for key,codes in missing.items(): print(len(codes),repr(key))
if invalid:print('INVALID:',invalid)
if missing or invalid:raise SystemExit(1)
