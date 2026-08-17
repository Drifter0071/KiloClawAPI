import sys
path = sys.argv[1]
with open(path, 'rb') as f:
    data = f.read()

# Replace the test body with explicit debug
old = b'''  test("no notes => empty index", () => {
    const { cache, dbs, dir } = mkCacheWithFixture([
      { KEY: 1, customer_id: 1, "AKTU\xc3\x81LIS N\xc3\x89V": "X Kft.", "BEJELENT\xc3\x89S SORSZ\xc3\x81MA": "B2408001", "1": "2024-08-15" },
    ]);'''
new = b'''  test("no notes => empty index", () => {
    const r0 = { KEY: 1, customer_id: 1, "AKTU\xc3\x81LIS N\xc3\x89V": "X Kft.", "BEJELENT\xc3\x89S SORSZ\xc3\x81MA": "B2408001", "1": "2024-08-15" };
    const k1 = "BEJELENT\xc3\x89S SORSZ\xc3\x81MA";
    const k2 = "BEJELENT\u00c9S SORSZ\u00c1MA";
    console.log("KEY HEX:", Buffer.from(k1).toString("hex"), "VS", Buffer.from(k2).toString("hex"));
    console.log("k1 === k2:", k1 === k2);
    console.log("r0[k1]:", r0[k1], "r0[k2]:", r0[k2]);
    const { cache, dbs, dir } = mkCacheWithFixture([r0]);'''
if old in data:
    data = data.replace(old, new)
    with open(path, 'wb') as f:
        f.write(data)
    print("OK")
else:
    print("NOT FOUND")
