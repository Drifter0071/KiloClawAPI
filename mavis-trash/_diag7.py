path = 'tests/18-linkage.test.ts'
with open(path, 'rb') as f:
    data = f.read()

# The "old" pattern
old_pattern = b'''  test("no notes => empty index", () => {
    console.log("ROW-DEBUG:");
    const { cache, dbs, dir } = mkCacheWithFixture([
      { KEY: 1, customer_id: 1, "AKTU\xc3\x81LIS N\xc3\x89V": "X Kft.", "BEJELENT\xc3\x89S SORSZ\xc3\x81MA": "B2408001", "1": "2024-08-15" },
    ]);'''

# Find each unique byte sequence
import re
needle = b'const { cache, dbs, dir } = mkCacheWithFixture(['
idx = data.find(needle)
print("needle at", idx)
# Print 50 bytes after to check encoding
end = data.find(b']);', idx) + 3
chunk = data[idx:end]
print("chunk:", repr(chunk))
print("pattern:", repr(old_pattern[-200:]))
