# TMedge synthetic training demo for the HKU SLURM cluster.
# Python 3 standard library only: no packages, dataset, modules or GPU needed.
# These generated examples test the job pipeline, not real seat occupancy.
import argparse
import math
import random
import sys


def probability(score):
    # This form avoids overflow while the model is learning.
    if score >= 0:
        return 1.0 / (1.0 + math.exp(-score))
    exponent = math.exp(score)
    return exponent / (1.0 + exponent)


def metrics(samples, weights):
    loss, correct = 0.0, 0
    for x1, x2, label in samples:
        score = weights[0] + weights[1] * x1 + weights[2] * x2
        loss += max(score, 0.0) - label * score + math.log1p(math.exp(-abs(score)))
        correct += int((score >= 0.0) == label)
    return loss / len(samples), correct / len(samples)


def main():
    parser = argparse.ArgumentParser(description="Train a small classifier on synthetic data.")
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--samples", type=int, default=1000)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--lr", type=float, default=0.5)
    args = parser.parse_args()
    if not 1 <= args.epochs <= 1000:
        parser.error("--epochs must be between 1 and 1000")
    if not 20 <= args.samples <= 100000:
        parser.error("--samples must be between 20 and 100000")
    if not math.isfinite(args.lr) or not 0.0 < args.lr <= 1.0:
        parser.error("--lr must be greater than 0 and at most 1")

    rng = random.Random(args.seed)
    samples = []
    for _ in range(args.samples):
        x1, x2 = rng.uniform(-1.0, 1.0), rng.uniform(-1.0, 1.0)
        label = int(0.25 + 2.0 * x1 - 1.5 * x2 + rng.gauss(0.0, 0.25) >= 0.0)
        samples.append((x1, x2, label))
    split = len(samples) * 4 // 5
    training, validation = samples[:split], samples[split:]
    weights = [0.0, 0.0, 0.0]

    print("TMedge synthetic training demo (no real sensor data)", flush=True)
    print(f"python {sys.version.split()[0]} | seed {args.seed}", flush=True)
    print(f"samples {len(training)} train / {len(validation)} validation", flush=True)
    for epoch in range(1, args.epochs + 1):
        gradient = [0.0, 0.0, 0.0]
        for x1, x2, label in training:
            score = weights[0] + weights[1] * x1 + weights[2] * x2
            error = probability(score) - label
            gradient[0] += error
            gradient[1] += error * x1
            gradient[2] += error * x2
        for index in range(len(weights)):
            weights[index] -= args.lr * gradient[index] / len(training)
        loss, accuracy = metrics(training, weights)
        print(f"epoch {epoch:02d}/{args.epochs} loss {loss:.4f} accuracy {accuracy:.4f}", flush=True)

    loss, accuracy = metrics(validation, weights)
    print(f"validation_loss {loss:.4f}", flush=True)
    print(f"validation_accuracy {accuracy:.4f}", flush=True)
    print("TMEDGE_EXAMPLE_OK", flush=True)


if __name__ == "__main__":
    main()
