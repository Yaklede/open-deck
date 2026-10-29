import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import https from "node:https";
import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import { createHost } from "../host/server.mjs";
import { defaultSettings } from "../host/settings.mjs";
import { loadIdentity, exportAuthority } from "../host/network.mjs";
import { writeJson } from "../host/config.mjs";

async function port() {
  const s = net.createServer(); s.listen(0, "127.0.0.1"); await once(s,"listening");
  const p=s.address().port; await new Promise(r=>s.close(r)); return p;
}
async function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"od-network-modes-"));
  const settings=defaultSettings(); settings.network.wifiPort=await port(); settings.network.tlsHttpsPort=await port(); settings.network.discoveryEnabled=false;
  writeJson(path.join(dir,"preferences.json"),settings);
  const host=createHost({dir,wifi:true,metrics:false,runner:async()=>""});
  if(!host.lanServer.listening) await once(host.lanServer,"listening");
  host.server.listen(0,"127.0.0.1"); await once(host.server,"listening");
  t.after(async()=>{await host.close();fs.rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${host.server.address().port}`;
  const api=async(route,method="GET",body)=>{const r=await fetch(base+route,{method,headers:{"X-Open-Deck-Admin":host.adminKey,"Content-Type":"application/json"},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};};
  return {dir,host,api,settings};
}
function tls(port, ca, route="/health",headers={}) {
  return new Promise((resolve,reject)=>{
    const q=https.get({hostname:"127.0.0.1",port,path:route,servername:"opendeck.local",ca,agent:false,headers},r=>{let body="";r.on("data",b=>body+=b);r.on("end",()=>resolve({status:r.statusCode,body:JSON.parse(body)}));});q.on("error",reject);q.setTimeout(2000,()=>q.destroy(Error("timeout")));
  });
}
test("Replace, Additional and disabled TLS expose the configured protocols while keeping admin routes local",async t=>{
  const {dir,host,api,settings}=await fixture(t),cert=loadIdentity(dir).cert;
  const {wifiPort,tlsHttpsPort}=settings.network;
  assert.equal((await tls(wifiPort,cert)).status,200);
  let r=await api("/api/admin/settings","PUT",{network:{tlsMode:"Additional"}}); assert.equal(r.status,200);
  assert.equal((await fetch(`http://127.0.0.1:${wifiPort}/health`)).status,200);
  assert.equal((await tls(tlsHttpsPort,cert)).status,200);
  assert.equal((await fetch(`http://127.0.0.1:${wifiPort}/api/admin/info`,{headers:{"X-Open-Deck-Admin":host.adminKey}})).status,403);
  const token=(await api("/api/pair","POST",{pin:host.getPin()})).body.token;
  assert.equal((await fetch(`http://127.0.0.1:${wifiPort}/api/snapshot`,{headers:{Authorization:"Bearer "+token}})).status,200);
  const controller = new AbortController();
  const events = await fetch(`http://127.0.0.1:${wifiPort}/api/events`, {headers:{Authorization:"Bearer "+token},signal:controller.signal});
  assert.equal(events.status,200);
  assert.equal((await api("/api/admin/info")).body.connections[0].transport,"wifi");
  assert.equal((await api("/api/admin/diagnostics")).body.connections[0].transport,"wifi");
  controller.abort();
  r=await api("/api/admin/settings","PUT",{network:{tlsEnabled:false}}); assert.equal(r.status,200);
  assert.equal((await fetch(`http://127.0.0.1:${wifiPort}/health`)).status,200);
  await assert.rejects(tls(tlsHttpsPort,cert));
  r=await api("/api/admin/settings","PUT",{network:{tlsEnabled:true,tlsMode:"Replace"}});assert.equal(r.status,200);
  assert.equal((await tls(wifiPort,cert)).status,200);
  r=await api("/api/admin/settings","PUT",{network:{wifiEnabled:false}});assert.equal(r.status,200);
  assert.deepEqual(r.body.network.urls,[]);
});
test("failed Additional HTTPS bind preserves original TLS identity, protocol and persisted settings",async t=>{
  const {dir,api,settings}=await fixture(t),cert=loadIdentity(dir).cert;
  const occupied=net.createServer();occupied.listen(0,"0.0.0.0");await once(occupied,"listening");t.after(()=>new Promise(r=>occupied.close(r)));
  const r=await api("/api/admin/settings","PUT",{network:{tlsMode:"Additional",tlsHttpsPort:occupied.address().port}});
  assert.equal(r.status,400);assert.equal((await tls(settings.network.wifiPort,cert)).status,200);
  assert.equal((await api("/api/admin/settings")).body.settings.network.tlsMode,"Replace");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,"preferences.json"))).network.tlsMode,"Replace");
});
test("local authority issue, leaf renewal and authority rotation produce valid chains and export only the public CA",async t=>{
  const {dir,api,settings}=await fixture(t);
  const issue=await api("/api/admin/certificate","POST",{operation:"issue-local-ca"});assert.equal(issue.status,200);assert.equal(issue.body.source,"local-ca");
  const first=loadIdentity(dir),root=exportAuthority(dir);
  assert.ok(new X509Certificate(first.cert).verify(new X509Certificate(root.certificatePem).publicKey));
  assert.equal((await tls(settings.network.wifiPort,root.certificatePem)).status,200);
  assert.ok(new X509Certificate(first.cert).checkIP("127.0.0.1"));
  const exported=await api("/api/admin/certificate/authority");assert.equal(exported.status,200);assert.ok(!JSON.stringify(exported.body).includes("PRIVATE KEY"));
  const renew=await api("/api/admin/certificate","POST",{operation:"issue-local-ca"});assert.equal(renew.status,200);assert.notEqual(renew.body.fingerprint,issue.body.fingerprint);assert.equal(renew.body.authority.fingerprint,root.fingerprint);
  const rotate=await api("/api/admin/certificate","POST",{operation:"regenerate-authority"});assert.equal(rotate.status,200);assert.notEqual(rotate.body.authority.fingerprint,root.fingerprint);
  await assert.rejects(tls(settings.network.wifiPort,root.certificatePem));
  assert.equal((await tls(settings.network.wifiPort,exportAuthority(dir).certificatePem)).status,200);
  for(const name of ["wifi-key.pem","wifi-cert.pem","wifi-ca-key.pem","wifi-ca-cert.pem"]) assert.equal(fs.statSync(path.join(dir,name)).mode&0o777,0o600);
});
