import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
const root = process.env.SOURCE_ROOT || path.resolve(import.meta.dirname,'../..');
const out = new Map();
const korean = /[가-힣]/;
const ignored = new Set(['M월 d일 EEEE HH:mm','M월 d일 EEEE','yyyy년 M월','일','월','화','수','목','금','토']);
const add = (source,file,english) => {
 if (!korean.test(source) || ignored.has(source)) return;
 const entry=out.get(source)||{source,files:[]}; if(!entry.files.includes(file)) entry.files.push(file);
 if(english && !korean.test(english)) entry.english=english; out.set(source,entry);
};
function jsFile(file) {
 const s=fs.readFileSync(path.join(root,file),'utf8'); let ast;
 try{ast=parse(s,{sourceType:'module',plugins:['importAttributes']});}catch{return;}
 function walk(n,p) {
  if(!n||typeof n!=='object')return;
  if(n.type==='StringLiteral') {
   let english;
   if(p?.type==='CallExpression'&&p.arguments[0]===n&&p.arguments[1]?.type==='StringLiteral'&&['t','text','translate'].includes(p.callee.name))english=p.arguments[1].value;
   add(n.value,file,english);
  }
  if(n.type==='TemplateLiteral')add(n.quasis.map((q,i)=>q.value.cooked+(i<n.expressions.length?`{${i}}`:'' )).join(''),file);
  for(const[k,v]of Object.entries(n))if(k!=='loc')if(Array.isArray(v))v.forEach(x=>walk(x,n));else if(v&&typeof v==='object')walk(v,n);
 }walk(ast);
}
for(const file of fs.readdirSync(path.join(root,'host/public')))if(/\.(?:m?js)$/.test(file)&&file!=='i18n.mjs')jsFile('host/public/'+file);
for(const file of fs.readdirSync(path.join(root,'host')))if(file.endsWith('.mjs'))jsFile('host/'+file);
for(const file of fs.readdirSync(path.join(root,'android/app/src/main/java/app/opendeck/client')))if(file.endsWith('.java')&&!['L10n.java','LocalePolicy.java'].includes(file)) {
 const name='android/app/src/main/java/app/opendeck/client/'+file;
 let s=fs.readFileSync(path.join(root,name),'utf8');
 // The Java formatter splits long constant arguments; inventory the compiled value.
 s=s.replace(/L10n\.(?:text|format)\(\s*((?:"(?:[^"\\]|\\.)*"\s*\+\s*)+"(?:[^"\\]|\\.)*")/g,(whole,expression)=>{
  const value=[...expression.matchAll(/"(?:[^"\\]|\\.)*"/g)].map(x=>JSON.parse(x[0])).join(''); add(value,name);
  return whole.replace(expression,'""');
 });
 for(const m of s.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"/g))if(m[0][0]==='"')try{add(JSON.parse(m[0]),name);}catch{}
}
const html=fs.readFileSync(path.join(root,'host/public/index.html'),'utf8');
for(const m of html.matchAll(/>([^<>]+)</g)){const value=m[1].replace(/\s+/g,' ').trim();add(value,'host/public/index.html');}
for(const m of html.matchAll(/(?:title|placeholder|aria-label)="([^"]+)"/g))add(m[1],'host/public/index.html');
const swift=fs.readFileSync(path.join(root,'macos/OpenDeck.swift'),'utf8');
for(const m of swift.matchAll(/"(?:[^"\\]|\\.)*"/g)){let source=m[0].slice(1,-1).replace(/\\n/g,'\n');if(!source.includes('\\('))add(source,'macos/OpenDeck.swift');}
const existing=path.join(root,'host/public/locales/sources.json');
fs.writeFileSync(existing,JSON.stringify([...out.values()].sort((a,b)=>a.source.localeCompare(b.source)),null,2)+'\n');
console.log(`${out.size} fixed UI/error source strings inventoried`);
