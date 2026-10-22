# Original-source compatibility fixtures

These archives contain synthetic data only. The password and recovery key in
`fixture-info.json` are public test vectors, not user or application credentials.

`Generate.cs` was compiled with the original Macro Deck v3.0.0-beta.18 sources at
commit `7089154cde506c0884bb39c4712863e0fef83d84`:

- `MacroDeckHost.Infrastructure/Portable/PortableArchiveCrypto.cs`
- `MacroDeckHost.Application/Portable/PortableEncryptionInfo.cs`
- `MacroDeckHost.Application/Portable/PortableKdfInfo.cs`
- `MacroDeckHost.Application/Backups/BackupRecoveryKeyFormat.cs`
- `MacroDeckHost.Infrastructure/Backups/Crypto/*.cs`

A temporary .NET 10 console project includes those source files and `Generate.cs`
with implicit usings and nullable enabled. No original source or binary is bundled
with Open Deck. Run that generator with this directory as its sole argument to
regenerate both archives. The generator's `verify <archive-path>` mode uses the
original C# decryptor to check an encrypted Open Deck portable export.

`test/macrodeck-portable.test.mjs` decrypts and imports the original-source profile
and backup fixtures. Separately, the original C# decryptor successfully read an
Open Deck-generated `.macroDeckProfile` using the public fixture password.

Supported archive scope: Profile/Folder/Widgets portable files, password-protected
portable files, and recovery-key encrypted backup profile/asset/basic-variable
migration. Legacy profile JSON/ZIP folder layouts are migrated with an explicit
warning for plugin actions and database-only data. Macro Deck accounts, credentials,
plugin executables and database contents are never applied. Unsupported widgets or
actions remain inert and are listed in the import/export report.
