{
  description = "redcrayonai — SpacetimeDB collaborative diagram POC";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfreePredicate = pkg:
            builtins.elem (pkgs.lib.getName pkg) [ "spacetimedb" ];
        };
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            spacetimedb
            nodejs_22
            pnpm_10
            postgresql_17 # dashboard activity store (scripts/pg.sh); same major as Neon
          ];
        };
      });
}
