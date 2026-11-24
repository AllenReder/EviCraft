"""Write complete partition replacements for offline evaluation test fixtures."""
import gzip
import json

from observation_codec import FORMAT, PARTITIONS


def write_observations(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, 'wt', encoding='utf-8') as stream:
        def emit(record):
            stream.write(json.dumps(record) + '\n')

        emit({**FORMAT, 'static': {key: rows[0][key] for key in ('schemaVersion', 'attempt')}})
        for row in rows:
            meta = {key: value for key, value in row.items() if key not in ('schemaVersion', 'attempt')}
            if isinstance(meta.get('evaluation'), dict):
                meta['evaluation'] = dict(meta['evaluation'])
            present, replace = 0, {}
            for index, (name, keys) in enumerate(PARTITIONS):
                container = meta if len(keys) == 1 else meta.get(keys[0], {})
                if container is not None and keys[-1] in container:
                    present |= 1 << index
                    replace[name] = container.pop(keys[-1])
            emit(dict(meta=meta, present=present, replace=replace))
