import subprocess, json, os, sys, urllib.request
fams=[l.strip().replace(' ','') for l in open('families.txt') if l.strip()]
ok=0; fail=[]
for fam in fams:
    dest=f"fonts/{fam}.ttf"
    if os.path.exists(dest) and os.path.getsize(dest)>5000: ok+=1; continue
    got=False
    for lic in ('ofl','apache','ufl'):
        try:
            out=subprocess.run(['gh','api',f'repos/google/fonts/contents/{lic}/{fam}'],capture_output=True,text=True,timeout=30)
            if out.returncode!=0: continue
            items=json.loads(out.stdout)
        except Exception: continue
        ttfs=[i for i in items if i['name'].lower().endswith('.ttf')]
        if not ttfs: continue
        # prefer a variable [wght] file, else -Regular, else shortest name
        def score(n):
            n=n.lower()
            return (0 if 'wght' in n else 1 if 'regular' in n else 2, len(n))
        ttfs.sort(key=lambda i:score(i['name']))
        url=ttfs[0].get('download_url')
        if not url: continue
        try:
            urllib.request.urlretrieve(url,dest)
            if os.path.getsize(dest)>5000: ok+=1; got=True; break
        except Exception: pass
    if not got: fail.append(fam)
print(f"downloaded OK: {ok} / {len(fams)}")
print("FAILED:", ', '.join(fail) if fail else 'none')
