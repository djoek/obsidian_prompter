"""download() with Hugging Face faked: no network."""

from types import SimpleNamespace

from huggingface_hub.hf_api import RepoFile

from prompter_voice import download as dl


def test_progress_is_one_rising_bar(monkeypatch):
    sizes = {"config.json": 200, "model.safetensors": 10_000}
    monkeypatch.setattr(dl, "is_cached", lambda *a: False)
    monkeypatch.setattr(
        dl,
        "HfApi",
        lambda: SimpleNamespace(
            get_paths_info=lambda repo, files: [
                RepoFile(path=f, size=sizes[f], oid="0") for f in files
            ]
        ),
    )

    def fake_download(repo, name, tqdm_class):
        # Like the real library: two bars for one file, updates interleaved.
        size = sizes[name]
        received = tqdm_class(total=size)
        written = tqdm_class(total=size)
        for _ in range(10):
            received.update(size // 10)
            written.update(size // 20)
        written.update(size - written.n)

    monkeypatch.setattr(dl, "hf_hub_download", fake_download)
    seen: list[tuple[int, int]] = []
    dl.download("some/model", lambda done, total: seen.append((done, total)))

    assert {total for _, total in seen} == {10_200}
    dones = [done for done, _ in seen]
    assert dones == sorted(dones), "progress went backwards"
    assert dones[0] == 0 and dones[-1] == 10_200


def test_cached_reports_done_without_network(monkeypatch):
    monkeypatch.setattr(dl, "is_cached", lambda *a: True)
    monkeypatch.setattr(dl, "HfApi", lambda: (_ for _ in ()).throw(AssertionError("network")))
    seen: list[tuple[int, int]] = []
    dl.download("some/model", lambda d, t: seen.append((d, t)))
    assert seen == [(1, 1)]
