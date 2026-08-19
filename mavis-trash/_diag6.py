path = 'tests/18-linkage.test.ts'
with open(path, 'rb') as f:
    data = f.read()

# Use a literal É byte sequence (0xc3 0x89) — same as in the existing test
old = b'''  test("no notes => empty index", () => {
    console.log("ROW-DEBUG:");
    const { cache, dbs, dir } = mkCacheWithFixture([
      { KEY: 1, customer_id: 1, "AKTU\xc3\x81LIS N\xc3\x89V": "X Kft.", "BEJELENT\xc3\x89S SORSZ\xc3\x81MA": "B2408001", "1": "2024-08-15" },
    ]);'''
new = b'''  test("no notes => empty index", () => {
    const r0 = { KEY: 1, customer_id: 1, "AKTU\xc3\x81LIS N\xc3\x89V": "X Kft.", "BEJELENT\xc3\x89S SORSZ\xc3\x81MA": "B2408001", "1": "2024-08-15" };
    console.log("r0 direct:", r0["BEJELENT\xc3\x89S SORSZ\xc3\x81MA"]);
    const k = "BEJELENT\xc3\x89S SORSZ\xc3\x81MA";
    console.log("r0 via k:", r0[k]);
    const { cache, dbs, dir } = mkCacheWithFixture([r0]);'''
if old in data:
    data = data.replace(old, new)
    with open(path, 'wb') as f:
        f.write(data)
    print("OK")
else:
    print("NOT FOUND")
