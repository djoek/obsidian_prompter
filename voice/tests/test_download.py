"""download() with Hugging Face faked: no network."""

from types import SimpleNamespace

from souffleur_voice import download as dl


def test_progress_is_one_rising_bar(monkeypatch):
    sizes = {"README.md": 5_000, "config.json": 200, "model.safetensors": 10_000}
    monkeypatch.setattr(dl, "is_cached", lambda *a: False)
    siblings = [SimpleNamespace(rfilename=f, size=n) for f, n in sizes.items()]
    monkeypatch.setattr(
        dl,
        "HfApi",
        lambda: SimpleNamespace(
            model_info=lambda repo, files_metadata: SimpleNamespace(siblings=siblings)
        ),
    )
    fetched: list[str] = []

    def fake_download(repo, name, tqdm_class):
        # Like the real library: two bars for one file, updates interleaved.
        fetched.append(name)
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

    assert fetched == ["config.json", "model.safetensors"]  # README.md skipped
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
