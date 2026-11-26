"""Detect a song's key and tempo from its separated stems.

Key comes from the pitched stems (drums excluded), tempo from the drums stem alone,
which is far more reliable than analysing the full mix.

Usage: uv run backend/analyze.py <stem_dir>  -> prints JSON
Self-check: uv run backend/analyze.py
"""
import json
import sys
from pathlib import Path

import numpy as np
import librosa

SR = 22050
# Krumhansl-Kessler key profiles, index 0 = tonic
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def detect_key(stems):
    """Return [(score, tonic 0-11 where 0=C, 'major'|'minor'), ...] best first.

    Each stem is scored on its own and the scores averaged. Scoring the summed mix let
    the bass dominate: a song in C whose bass sits on E a lot came out as E minor.
    """
    chromas = [librosa.feature.chroma_cqt(y=y, sr=SR).mean(axis=1) for y in stems]
    return sorted(((round(float(np.mean([np.corrcoef(c, np.roll(prof, t))[0, 1] for c in chromas])), 3), t, mode)
                   for mode, prof in (("major", MAJOR), ("minor", MINOR)) for t in range(12)), reverse=True)


def detect_bpm(y):
    tempo, _ = librosa.beat.beat_track(y=y, sr=SR)
    bpm = float(np.atleast_1d(tempo)[0])
    # ponytail: fold half/double-time guesses into 70-180; a song that's really 60 BPM reads as 120
    while bpm and bpm < 70:
        bpm *= 2
    while bpm > 180:
        bpm /= 2
    return round(bpm, 1)


def analyze(stem_dir):
    load = lambda p: librosa.load(p, sr=SR, mono=True)[0]
    pitched = [load(p) for p in stem_dir.glob("*.wav") if p.stem != "drums"]
    drums = stem_dir / "drums.wav"
    (score, tonic, mode), (alt_score, alt_tonic, alt_mode) = detect_key(pitched)[:2]
    return {"tonic": tonic, "mode": mode, "keyConfidence": score,
            # runner-up, shown when it's nearly as likely (e.g. C major vs G major)
            "alt": {"tonic": alt_tonic, "mode": alt_mode, "gap": round(score - alt_score, 3)},
            "bpm": detect_bpm(load(drums) if drums.exists() else sum(pitched))}


def selftest():
    t = np.arange(SR * 8) / SR
    tone = lambda midi: np.sin(2 * np.pi * 440 * 2 ** ((midi - 69) / 12) * t)
    # A minor triad with a low A in the bass -> A minor (tonic 9)
    assert detect_key([sum(tone(m) for m in (45, 57, 60, 64))])[0][1:] == (9, "minor")
    # G major triad + bass G -> G major (tonic 7)
    assert detect_key([sum(tone(m) for m in (43, 55, 59, 62))])[0][1:] == (7, "major")
    # loud bass sitting on E must not outvote quieter C-major parts: per-stem averaging
    c_major = [3 * tone(40), sum(tone(m) for m in (60, 64, 67)), sum(tone(m) for m in (65, 69, 72)) + tone(67)]
    assert detect_key(c_major)[0][1:] != (4, "minor")
    # click every 0.5s = 120 BPM
    clicks = librosa.clicks(times=np.arange(0, 8, 0.5), sr=SR, length=len(t))
    assert abs(detect_bpm(clicks) - 120) < 3, detect_bpm(clicks)
    print("ok")


if __name__ == "__main__":
    # run as a subprocess by the server so librosa's ~800 MB is freed when it exits
    print(json.dumps(analyze(Path(sys.argv[1])))) if len(sys.argv) > 1 else selftest()
