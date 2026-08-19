import sys
path = sys.argv[1]
with open(path, 'rb') as f:
    data = f.read()

# Add console.log right after `for (const r of rows) {` in mkCacheWithFixture
target = b'  for (const r of rows) {'
idx = data.find(target)
if idx < 0:
    print("not found")
    sys.exit(1)
end = idx + len(target)
insert = b'\n    console.log("ROW keys:", Object.keys(r), "sorszam:", JSON.stringify(r["BEJELENT\u00c9S SORSZ\u00c1MA"]));'
data = data[:end] + insert + data[end:]
with open(path, 'wb') as f:
    f.write(data)
print("OK")
