# The self-host images (RC-608), tagged as compose.prod.yml names them. From
# the repo root:
#
#   docker buildx bake -f docker/prod/docker-bake.hcl --load            # this machine's platform
#   TAG=1.2.3 docker buildx bake -f docker/prod/docker-bake.hcl --push \
#     --set '*.platform=linux/amd64,linux/arm64'                        # what release-images.yml runs

variable "REGISTRY" { default = "ghcr.io/redcrayonai" }
variable "TAG" { default = "dev" }

group "default" {
  targets = ["canvas", "dashboard", "mcp", "module-setup", "importer"]
}

target "_prod" {
  context    = "."
  dockerfile = "docker/prod/Dockerfile"
}

target "canvas" {
  inherits = ["_prod"]
  target   = "canvas"
  tags     = ["${REGISTRY}/redcrayon-canvas:${TAG}"]
}

target "dashboard" {
  inherits = ["_prod"]
  target   = "dashboard"
  tags     = ["${REGISTRY}/redcrayon-dashboard:${TAG}"]
}

target "mcp" {
  inherits = ["_prod"]
  target   = "mcp"
  tags     = ["${REGISTRY}/redcrayon-mcp:${TAG}"]
}

target "module-setup" {
  inherits = ["_prod"]
  target   = "module-setup"
  tags     = ["${REGISTRY}/redcrayon-module-setup:${TAG}"]
}

target "importer" {
  context = "importer"
  tags    = ["${REGISTRY}/redcrayon-importer:${TAG}"]
}
