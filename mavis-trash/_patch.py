import sys
path = sys.argv[1]
old_marker = sys.argv[2]
new_marker = sys.argv[3]
with open(path, 'rb') as f:
    data = f.read()
# Use the markers to find the start and end
start = data.find(old_marker)
if start < 0:
    print("START NOT FOUND")
    sys.exit(1)
end = data.find(new_marker, start)
if end < 0:
    print("END NOT FOUND")
    sys.exit(1)
end += len(new_marker)
# Read the line containing the "no notes" test
# Simpler: find the test("no notes..." line and the closing });
no_notes_start = data.find(b'test("no notes', start)
no_notes_end = data.find(b"  });", no_notes_start) + len(b"  });")
print(f"Replacing bytes {no_notes_start}..{no_notes_end}")
new_block = b'''  test("no notes => empty index", () => {
    const r = { KEY: 1, customer_id: 1, "AKTU\xc3\x81LIS N\xc3\x89V": "X Kft.", "BEJELENT\xc3\x89S SORSZ\xc3\x81MA": "B2408001", "1": "2024-08-15" };
    console.log("DEBUG sorszam:", JSON.stringify(r["BEJELENT\xc3\x89S SORSZ\xc3\x81MA"]), "type:", typeof r["BEJELENT\xc3\x89S SORSZ\xc3\x81MA"]);
    const { cache, dbs, dir } = mkCacheWithFixture([r]);
    const idx = buildLinkageIndex(cache);
    expect(idx.total).toBe(0);
    expect(idx.forward.size).toBe(0);
    cleanup(dbs, dir);
  });'''
data = data[:no_notes_start] + new_block + data[no_notes_end:]
with open(path, 'wb') as f:
    f.write(data)
print("OK")
