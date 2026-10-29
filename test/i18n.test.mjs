import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {locales,resolveLocale,installCatalog,setLocale,t,tf,translateError,localizedObject} from '../host/public/i18n.mjs';
const root=path.resolve(import.meta.dirname,'..');
const folder=path.join(root,'host/public/locales');
const sources=JSON.parse(fs.readFileSync(path.join(folder,'sources.json'),'utf8'));
const codes=locales.filter(x=>x.code!=='system').map(x=>x.code);
const placeholders=s=>[...s.matchAll(/\{\{[^{}]+\}\}|\{\d+\}|%[,.0-9]*[dfs]/g)].map(x=>x[0]).sort();
for(const code of codes){
 test(`${code}: every inventoried product string has a translation, preserves placeholders, and matches Android assets`,()=>{
  const data=fs.readFileSync(path.join(folder,code+'.json'),'utf8'),catalog=JSON.parse(data);
  for(const {source}of sources){
   assert.equal(typeof catalog[source],'string',`${code} missing ${source}`);
   assert.ok(catalog[source].trim(),`${code} empty ${source}`);
   assert.deepEqual(placeholders(catalog[source]),placeholders(source),`${code} placeholders ${source}`);
   if(code!=='ko')assert.doesNotMatch(catalog[source].replace(/\{\{[^{}]+\}\}/g,''),/[가-힣]/,`${code} untranslated Korean ${source}`);
  }
  assert.equal(fs.readFileSync(path.join(root,'android/app/src/main/assets/locales',code+'.json'),'utf8'),data);
  installCatalog(code,catalog);
 });
}
test('locale matching follows the reference 19-language list and regional Chinese rules',()=>{
 assert.equal(codes.length,19);assert.equal(resolveLocale('system','zh-HK'),'zh-TW');
 assert.equal(resolveLocale('system','zh-Hant-TW'),'zh-TW');assert.equal(resolveLocale('system','zh-CN'),'zh');
 assert.equal(resolveLocale('system','pt-PT'),'pt-BR');assert.equal(resolveLocale('de','ko-KR'),'de');
 assert.equal(resolveLocale('system','sv-SE'),'en');
});
test('language changes update known product labels while preserving user text and dynamic values',async()=>{
 const labels=localizedObject({save:'저장'});const before=structuredClone({name:'내가 만든 페이지',title:'Original 업무 제목 ${x}',notes:'arbitrary {{user}}'});
 for(const code of codes){
  await setLocale(code);
  assert.equal(labels.save,t('저장'));
  assert.equal(t(before.name),before.name);
  const template='호스트를 시작하지 못했습니다: {0}';
  const result=tf(template,before.title);
  assert.ok(result.includes(before.title));assert.ok(!result.includes('{0}'));
  const server=translateError(template.replace('{0}',before.title));assert.equal(server,result);
  assert.equal(translateError('External error: '+before.notes),'External error: '+before.notes);
 }
 await setLocale('ko');
});
test('Wi-Fi HTTP remains explicit, private-LAN-only, and cannot redirect bearer tokens',()=>{
 const policy=fs.readFileSync(path.join(root,'android/app/src/main/java/app/opendeck/client/ClientSettingsPolicy.java'),'utf8');
 const transport=fs.readFileSync(path.join(root,'android/app/src/main/java/app/opendeck/client/PinnedConnection.java'),'utf8');
 assert.match(policy,/v\.put\("allowInsecureWifi", false\)/);
 assert.match(transport,/ClientSettingsPolicy\.validWifiUrl\(origin, allowInsecureWifi\)/);
 assert.equal((transport.match(/setInstanceFollowRedirects\(false\)/g)||[]).length,2);
});
