import sys
path = sys.argv[1]
with open(path, 'rb') as f:
    data = f.read()

target = b'test("no notes'
idx = data.find(target)
if idx < 0:
    print("not found")
    sys.exit(1)

# Insert a console.log right after the test header
# Find end of line after test("no notes => empty index", () => {
hdr_end = data.find(b"() => {", idx) + len(b"() => {")
insert = b'\n    console.log("ROW-DEBUG:");'
data = data[:hdr_end] + insert + data[hdr_end:]
with open(path, 'wb') as f:
    f.write(data)
print("OK")
