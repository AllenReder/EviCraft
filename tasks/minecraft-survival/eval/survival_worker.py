"""Importable worker for independent, streaming single-Attempt scoring processes."""
import importlib.util
from pathlib import Path


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('survival_scorer', HERE / 'score-survival.py')
scorer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scorer)


def score_job(job):
    attempt, rubric, output = map(Path, job)
    target = output / 'attempts' / attempt.name
    scorer.score_attempt(attempt, rubric, target)
    return target / 'score.json'
