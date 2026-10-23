/** Fixed product UI localization. User deck labels and external data never enter this layer. */
export const locales = [
  {code:'system',name:'System / 기기 설정'}, {code:'ar',name:'العربية'},
  {code:'pt-BR',name:'Português (Brasil)'},{code:'cs',name:'Čeština'},
  {code:'nl',name:'Nederlands'},{code:'en',name:'English'},{code:'fr',name:'Français'},
  {code:'de',name:'Deutsch'},{code:'hi',name:'हिन्दी'},{code:'id',name:'Bahasa Indonesia'},
  {code:'it',name:'Italiano'},{code:'ja',name:'日本語'},{code:'ko',name:'한국어'},
  {code:'pl',name:'Polski'},{code:'ru',name:'Русский'},{code:'zh',name:'简体中文'},
  {code:'es',name:'Español'},{code:'zh-TW',name:'繁體中文'},{code:'tr',name:'Türkçe'},
  {code:'uk',name:'Українська'},
];
const codes = new Set(locales.map(x=>x.code));
export function resolveLocale(value, system='ko') {
  if(!value||value==='system')value=system;
  value=String(value).replaceAll('_','-');
  if(/^zh-(TW|HK|MO|Hant)/i.test(value))return 'zh-TW';
  if(/^pt(?:-|$)/i.test(value))return 'pt-BR';
  const base=value.split('-')[0].toLowerCase();
  return codes.has(value)&&value!=='system'?value:codes.has(base)?base:'en';
}
const browser=typeof document!=='undefined';
const systemLocale=()=>browser?navigator.language:'ko';
let current=resolveLocale(browser?localStorage.getItem('opendeck.language')||'system':'ko',systemLocale());
let initialized=false;
const catalogs=new Map(),loading=new Map();
const staticNodes=[];
export const locale=()=>current;
export const isRTL=()=>current==='ar';
export function installCatalog(code,entries){catalogs.set(code,Object.freeze({...entries}));}
async function load(code){
 if(catalogs.has(code)||code==='ko')return;
 if(!loading.has(code))loading.set(code,fetch(`/locales/${code}.json`,{cache:'no-cache'}).then(r=>{if(!r.ok)throw Error(`Locale ${code}: ${r.status}`);return r.json();}).then(data=>installCatalog(code,data)).finally(()=>loading.delete(code)));
 return loading.get(code);
}
export function t(source,englishHint,requestedLocale) {
 if(typeof source!=='string')return source;
 const code=requestedLocale?resolveLocale(requestedLocale,systemLocale()):current;
 if(code==='ko')return source;
 return catalogs.get(code)?.[source] ?? (code==='en'&&englishHint?englishHint:source);
}
export function localizedObject(source) { return new Proxy({...source}, { get(target,key) { const value=target[key]; return typeof value === "string" ? t(value) : value; } }); }
export function tf(source,...values){return t(source).replace(/\{(\d+)\}/g,(match,n)=>n<values.length?String(values[n]):match);}
const escaped=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
/** Only known product error templates are translated; interpolated provider/user values are preserved. */
export function translateError(message){
 if(typeof message!=='string')return message;
 const direct=t(message);if(direct!==message)return direct;
 const entries=catalogs.get(current);if(!entries)return message;
 for(const [source,target]of Object.entries(entries)){
  if(!/\{\d+\}/.test(source))continue;
  const slots=[];let pattern='',cursor=0;
  for(const match of source.matchAll(/\{(\d+)\}/g)){pattern+=escaped(source.slice(cursor,match.index))+'([\\s\\S]*?)';slots.push(+match[1]);cursor=match.index+match[0].length;}
  pattern+=escaped(source.slice(cursor));const matched=new RegExp('^'+pattern+'$').exec(message);
  if(matched){const values={};slots.forEach((slot,i)=>values[slot]=matched[i+1]);return target.replace(/\{(\d+)\}/g,(m,n)=>values[n]??m);}
 }
 return message;
}
function captureStatic(){
 const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
 while(walker.nextNode()){
  const node=walker.currentNode;if(['SCRIPT','STYLE'].includes(node.parentElement?.tagName))continue;
  const source=node.textContent.replace(/\s+/g,' ').trim();if(/[가-힣]/.test(source))staticNodes.push({node,source,last:node.textContent,attribute:null});
 }
 for(const node of document.querySelectorAll('[title],[placeholder],[aria-label]'))for(const attribute of ['title','placeholder','aria-label']){const source=node.getAttribute(attribute);if(source&&/[가-힣]/.test(source))staticNodes.push({node,source,last:source,attribute});}
}
function applyStatic(){
 document.documentElement.lang=current;
 // Keep the editor/deck grid positions unchanged; only forms/dialogs use RTL reading order.
 document.documentElement.dataset.uiDirection=isRTL()?'rtl':'ltr';
 for(const item of staticNodes){
  const currentText=item.attribute?item.node.getAttribute(item.attribute):item.node.textContent;
  if(currentText!==item.last)continue; // App-written/user data must never be replaced.
  const value=t(item.source);if(item.attribute)item.node.setAttribute(item.attribute,value);else item.node.textContent=value;item.last=value;
 }
}
export async function initI18n(){
 if(!browser||initialized)return;
 await load(current);captureStatic();applyStatic();initialized=true;
}
export async function setLocale(value){
 const next=resolveLocale(value,systemLocale());await load(next);
 if(browser)localStorage.setItem('opendeck.language',value||'system');
 const changed=next!==current;current=next;if(browser)applyStatic();
 if(browser&&changed&&initialized)window.dispatchEvent(new CustomEvent('opendeck:languagechange',{detail:{locale:next}}));
}
if(browser)await initI18n();
