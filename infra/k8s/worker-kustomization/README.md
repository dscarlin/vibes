# Worker Kustomize

## Usage

1) Fill `.env` with all required values and set `WORKER_IMAGE`.
2) Run:

```
./scripts/kustomize-worker-from-env.sh
```

3) Apply:

```
KUSTOMIZATION_FILE=infra/k8s/worker-kustomization/kustomization.generated.yaml \
  kubectl kustomize -f "$KUSTOMIZATION_FILE" | kubectl apply -f -
```

This will create:
- `worker-config` ConfigMap
- `worker-secrets` Secret
- `vibes-worker` Deployment

Ensure `infra/k8s/worker-service-account.yaml` has the correct IRSA role ARN.
