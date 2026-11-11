# draw Helm chart

Runs the self-host stack (`compose.prod.yml`) on Kubernetes: the canvas,
dashboard, MCP server, import runner, database and Postgres, behind one Ingress.

```sh
helm install draw oci://ghcr.io/redcrayonai/charts/draw --version <release> \
  --namespace draw --create-namespace -f draw-values.yaml --timeout 15m
```

The full guide, with the values file, TLS, agent keys, upgrades and backups:
[Self-host on Kubernetes](https://docs.redcrayon.ai/self-host/kubernetes/)
(source: `docs/src/content/docs/self-host/kubernetes.md`). Every value is
described in [values.yaml](values.yaml).

Each `v*` release pushes the chart with the images (`.github/workflows/release-images.yml`);
chart and image versions match. From a checkout, with images you built
(`docker/prod/README.md`):

```sh
helm install draw charts/draw --set image.tag=dev --set domain=draw.example.com ...
```
