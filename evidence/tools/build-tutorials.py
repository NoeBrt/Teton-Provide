"""Cut pointer tutorials from the original browser recordings; requires FFmpeg."""
import json
import subprocess
from pathlib import Path

repo = Path(__file__).resolve().parents[2]
root = repo / "docs/assets/demos"
checks = repo / "evidence/checks/demos"
for layout in ('mobile', 'desktop'):
    data = json.loads((checks / f'{layout}-capture.json').read_text())
    captures = {item['label']: item['at'] for item in data['captures']}
    ranges = {
        'technician-code': [(2, captures['technician'] + 3, 1)],
        'site-wifi': [(captures['technician'] + 3, data['setupEnd'], 1)],
        'sensor-test': [(data['batchStart'] + 1.5, captures['test'] + 2.2, 1)],
        'sensor-setup': [(captures['test'] + 2.2, captures['manual'] + 2, 1)],
        'configure-all': [(captures['manual'] + 2, captures['running'] + 1, 1),
                          (captures['running'] + 1, captures['errors'] - 1, 4),
                          (captures['errors'] - 1, data['end'], 1)],
    }
    for action, segments in ranges.items():
        filters = []
        for index, (start, end, speed) in enumerate(segments):
            assert end > start
            filters.append(f'[0:v]trim=start={start}:end={end},setpts=(PTS-STARTPTS)/{speed}[s{index}]')
        streams = ''.join(f'[s{i}]' for i in range(len(segments)))
        filters.append(f'{streams}concat=n={len(segments)}:v=1:a=0,fps=25,format=yuv420p[out]')
        target = root / f'{layout}-{action}.mp4'
        subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', data['video'],
                        '-filter_complex', ';'.join(filters), '-map', '[out]',
                        '-c:v', 'libx264', '-crf', '18', '-preset', 'fast',
                        '-movflags', '+faststart', '-an', str(target)], check=True)
        print(target.name, flush=True)
