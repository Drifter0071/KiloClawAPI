with open('tests/18-linkage.test.ts', 'rb') as f:
    data = f.read()
idx = data.find(b'test("no notes')
print('found at', idx)
print(repr(data[idx:idx+300]))
