# PyInstaller spec for the Jarvis sidecar (onedir: Tauri copies the folder into Contents/Resources/backend).
from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_submodules

datas, binaries, hiddenimports = [], [], []
for package in ("mlx", "laya_mlx", "tokenizers", "huggingface_hub", "keyring"):
    d, b, h = collect_all(package)
    datas += d
    binaries += b
    hiddenimports += h
hiddenimports += collect_submodules("uvicorn") + collect_submodules("websockets") + collect_submodules("keyring.backends")
hiddenimports += ["jarvis.server", "jarvis.app", "jarvis.task", "jarvis.tools", "jarvis.policy", "jarvis.goal_runner"]
datas += [("jarvis/page.js", "jarvis")]
datas += collect_data_files("certifi")

a = Analysis(
    ["launcher.py"], pathex=["."], binaries=binaries, datas=datas, hiddenimports=hiddenimports,
    excludes=["tkinter", "matplotlib", "PIL.ImageTk", "pytest", "torch", "transformers"], noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="jarvis-backend", console=True, debug=False, strip=False, upx=False)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="jarvis-backend")
