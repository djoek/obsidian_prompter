"""Download a model from Hugging Face, reporting progress in bytes.

huggingface_hub draws its progress with `tqdm` and lets us pass our own tqdm
class. Ours never draws anything; it only forwards "bytes done / bytes total"
to a callback, which the server turns into messages for the plugin.

After this, the model loader finds the files in the cache and loads instantly.
"""

import io
from collections.abc import Callable

from huggingface_hub import HfApi, hf_hub_download, try_to_load_from_cache
from huggingface_hub.hf_api import RepoFile
from huggingface_hub.utils import tqdm as hf_tqdm

# (bytes done, bytes total)
Progress = Callable[[int, int], None]

# What parakeet-mlx loads. The weights are nearly all of the size.
PARAKEET_FILES = ("config.json", "model.safetensors")


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


def is_cached(model_id: str, files: tuple[str, ...] = PARAKEET_FILES) -> bool:
    return all(isinstance(try_to_load_from_cache(model_id, f), str) for f in files)


def download(model_id: str, on_progress: Progress, files: tuple[str, ...] = PARAKEET_FILES) -> None:
    """Fetch `files` of `model_id` into the Hugging Face cache.

    Asks for all file sizes first, so progress is one bar that only goes up.
    Does nothing (beyond reporting "done") when everything is cached, which
    also means no network is needed after the first start.
    """
    if is_cached(model_id, files):
        on_progress(1, 1)
        return
    infos = HfApi().get_paths_info(model_id, list(files))
    sizes = {i.path: i.size for i in infos if isinstance(i, RepoFile)}
    total = sum(sizes.values()) or 1
    offset = [0]
    on_progress(0, total)
    reporter = _reporter(on_progress, offset, total)
    for name in files:
        hf_hub_download(model_id, name, tqdm_class=reporter)
        offset[0] += sizes.get(name, 0)
        on_progress(min(offset[0], total), total)
