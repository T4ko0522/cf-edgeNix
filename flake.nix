{
  description = "CF-EdgeNix — Cloudflare-native Nix binary cache";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    nix-vite-plus.url = "github:ryoppippi/nix-vite-plus";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      nix-vite-plus,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          packages = [
            nix-vite-plus.packages.${system}.vp
          ]
          ++ (with pkgs; [
            bun
            nodejs_22
            git
            zstd
            nix
          ]);
        };
      }
    );
}
