"""Stream the partition-replace encoding into complete logical observations."""
import gzip
import json
from pathlib import Path
import sys


FORMAT_PATH = Path(__file__).with_name('observation-format.json')
FORMAT = json.loads(FORMAT_PATH.read_bytes())
PARTITIONS = [(name, name.split('.')) for name in FORMAT['partitions']]


def decode_observations(records):
    records = iter(records)
    header = next(records, None)
    if not header or any(header.get(key) != value for key, value in FORMAT.items()):
        raise ValueError('Expected observation-partition-replace encoding version 1; convert old logs first')
    state = {}
    for record in records:
        state.update(record.get('replace', {}))
        row = {**header['static'], **record['meta']}
        if isinstance(row.get('evaluation'), dict):
            row['evaluation'] = dict(row['evaluation'])
        for index, (name, keys) in enumerate(PARTITIONS):
            if not record['present'] & (1 << index):
                continue
            container = row if len(keys) == 1 else row.setdefault(keys[0], {})
            container[keys[-1]] = state[name]
        yield row


if __name__ == '__main__':
    with gzip.open(Path(sys.argv[1]), 'rb') as stream:
        for row in decode_observations(json.loads(raw) for raw in stream):
            print(json.dumps(row, ensure_ascii=False, separators=(',', ':')))
