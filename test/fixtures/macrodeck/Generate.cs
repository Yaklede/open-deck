// Compatibility fixture generator: compile against the original Macro Deck source,
// not the Open Deck implementation. Fixtures contain only synthetic public data.
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using MacroDeckHost.Application.Portable;
using MacroDeckHost.Application.Backups;
using MacroDeckHost.Infrastructure.Portable;
using MacroDeckHost.Infrastructure.Backups.Crypto;
var options=new JsonSerializerOptions{PropertyNamingPolicy=JsonNamingPolicy.CamelCase};
byte[] Json(object value)=>JsonSerializer.SerializeToUtf8Bytes(value,options);
byte[] Zip(Dictionary<string,byte[]> entries){using var m=new MemoryStream();using(var z=new ZipArchive(m,ZipArchiveMode.Create,true))foreach(var e in entries){using var s=z.CreateEntry(e.Key).Open();s.Write(e.Value);}return m.ToArray();}
byte[] Entry(ZipArchive z,string name){using var s=z.GetEntry(name)!.Open();using var m=new MemoryStream();s.CopyTo(m);return m.ToArray();}
if(args.Length>1&&args[0]=="verify"){
 using var z=new ZipArchive(File.OpenRead(args[1]));var manifest=Entry(z,"manifest.json");var m=JsonDocument.Parse(manifest);var encryption=JsonSerializer.Deserialize<PortableEncryptionInfo>(m.RootElement.GetProperty("encryption").GetRawText(),options)!;
 var result=PortableArchiveCrypto.TryDecrypt(Entry(z,"payload.enc"),encryption,manifest,"public-fixture-password",out var plain);
 if(result!=PortableDecryptResult.Success)throw new Exception("Open Deck export could not be decrypted by original Macro Deck source");using var inner=new ZipArchive(new MemoryStream(plain!));var content=JsonDocument.Parse(Entry(inner,"content.json"));if(content.RootElement.GetProperty("kind").GetString()!="Profile")throw new Exception("wrong kind");Console.WriteLine("Original Macro Deck C# decrypted Open Deck export successfully");return;
}
var output=args[0];Directory.CreateDirectory(output);
var profile=new{id="11111111-1111-1111-1111-111111111111",name="Source fixture",defaultColumns=4,defaultRows=3,folders=new[]{new{id="22222222-2222-2222-2222-222222222222",name="Home",isDefault=true,widgets=new[]{new{id="33333333-3333-3333-3333-333333333333",type="ActionButton",positionX=0,positionY=0,width=2,height=1,data="{\"label\":\"Source fixture button\"}"}}}}};
var encryptionInfo=PortableArchiveCrypto.CreateParameters();var portableManifest=Json(new{formatVersion=2,kind="Profile",appVersion="3.0.0-beta.18",encryption=encryptionInfo});var innerPortable=Zip(new(){["content.json"]=Json(new{kind="Profile",profile})});var portablePayload=PortableArchiveCrypto.Encrypt(innerPortable,"public-fixture-password",encryptionInfo,portableManifest);File.WriteAllBytes(Path.Combine(output,"original-source.macroDeckProfile"),Zip(new(){["manifest.json"]=portableManifest,["payload.enc"]=portablePayload}));
var recovery=Enumerable.Range(0,32).Select(i=>(byte)i).ToArray();var checksum=new byte[2];BackupRecoveryKeyFormat.DeriveChecksum(recovery,checksum);var keyText=BackupRecoveryKeyFormat.Format(recovery,checksum);
var backupManifest=Json(new{formatVersion=1,macroDeckVersion="3.0.0-beta.18",recoveryKeyId=BackupKeyDerivation.DeriveKeyId(recovery),encryption=new{version=1,cipher="AES-256-GCM-STREAM",kdf="HKDF-SHA256"}});var profileBytes=Json(profile);var db=Encoding.UTF8.GetBytes("Synthetic excluded database");var contentIndex=Json(new{entries=new[]{new{path="files/data/profiles/profile.json",size=profileBytes.Length,sha256=Convert.ToHexStringLower(SHA256.HashData(profileBytes)),component="Profiles"}},database=new{path="db/database.db",size=db.Length,sha256=Convert.ToHexStringLower(SHA256.HashData(db))}});
var innerBackup=Zip(new(){["manifest.json"]=backupManifest,["content.json"]=contentIndex,["files/data/profiles/profile.json"]=profileBytes,["db/database.db"]=db});using var payload=new MemoryStream();using(var encrypted=BackupPayloadCrypto.CreateEncryptor(payload,recovery,backupManifest,true))encrypted.Write(innerBackup);File.WriteAllBytes(Path.Combine(output,"original-source.macroDeckBackup"),Zip(new(){["manifest.json"]=backupManifest,["payload.enc"]=payload.ToArray()}));File.WriteAllText(Path.Combine(output,"fixture-info.json"),JsonSerializer.Serialize(new{sourceRevision="7089154cde506c0884bb39c4712863e0fef83d84",password="public-fixture-password",recoveryKey=keyText},options));Console.WriteLine("Original Macro Deck source fixtures generated");
