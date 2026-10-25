"""Identify Git source or the baseline of a Git-less source download truthfully."""
import json
import subprocess

def source_info(root):
    if (root / '.git').exists():
        return {
            'sourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
            'workingTreeDirty': bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=root, text=True).strip()),
        }
    file = root / 'SOURCE-INFO.json'
    return {'sourceCommit': json.loads(file.read_text())['sourceCommit'] if file.exists() else None,
            'workingTreeDirty': None, 'sourceArchiveBaseline': True}
