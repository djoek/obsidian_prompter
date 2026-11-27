"""Download a model from Hugging Face, reporting progress in bytes.

huggingface_hub draws its progress with `tqdm` and lets us pass our own tqdm
class. Ours never draws anything; it only forwards "bytes done / bytes total"
to a callback, which the server turns into messages for the plugin.

After this, the model loader finds the files in the cache and loads instantly.
"""

import io
from collections.abc import Callable
from pathlib import Path

from huggingface_hub import HfApi, hf_hub_download, snapshot_download
from huggingface_hub.errors import LocalEntryNotFoundError
from huggingface_hub.utils import tqdm as hf_tqdm

# (bytes done, bytes total)
Progress = Callable[[int, int], None]

# Files in a model repository that loading doesn't need.
SKIP = (".md", ".gitattributes", "LICENSE", "LICENSE.md", ".png", ".jpg")


def _reporter(callback: Progress, offset: list[int], total: int) -> type[hf_tqdm]:
    """A tqdm class that reports into `callback`. `offset` holds the bytes of
    files already finished, so all files add up to one bar out of `total`.

    One file can get two bars at once (bytes received, bytes written), whose
    updates interleave; reporting the highest value seen keeps ours steady.
    """
    best = [0]

    class Reporter(hf_tqdm):
        def __init__(self, *args, **kwargs) -> None:  # noqa: ANN002, ANN003
            # Count even if progress bars are switched off, and print nowhere.
            kwargs["disable"] = False
            kwargs["file"] = io.StringIO()
            super().__init__(*args, **kwargs)

        def update(self, n: float | None = 1) -> bool | None:
            shown = super().update(n)
            best[0] = max(best[0], min(offset[0] + int(self.n), total))
            callback(best[0], total)
            return shown

    return Reporter


def is_cached(model_id: str) -> bool:
    """True if a complete-looking copy is in the cache (no network needed)."""
    try:
        folder = Path(snapshot_download(model_id, local_files_only=True))
    except LocalEntryNotFoundError:
        return False
    return (folder / "config.json").exists() and any(folder.glob("*.safetensors"))


def download(model_id: str, on_progress: Progress) -> None:
    """Fetch the model files of `model_id` into the Hugging Face cache.

    Asks for the file list with sizes first, so progress is one bar that only
    goes up. Does nothing (beyond reporting "done") when the model is cached,
    which also means no network is needed after the first start.
    """
    if is_cached(model_id):
        on_progress(1, 1)
        return
    info = HfApi().model_info(model_id, files_metadata=True)
    files = [
        (s.rfilename, s.size or 0) for s in info.siblings or [] if not s.rfilename.endswith(SKIP)
    ]
    total = sum(size for _, size in files) or 1
    offset = [0]
    on_progress(0, total)
    reporter = _reporter(on_progress, offset, total)
    for name, size in files:
        hf_hub_download(model_id, name, tqdm_class=reporter)
        offset[0] += size
        on_progress(min(offset[0], total), total)
