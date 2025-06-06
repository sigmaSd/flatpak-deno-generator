This tool lives now upstream https://jsr.io/@sigmasd/flatpak-deno-generator/settings

# Flatpak Deno Generator

```
deno -RN -W=. jsr:@sigmasd/flatpak-deno-generator deno.lock
```

This will create a `deno-sources.json` that can be used in flatpak build files:

- it creates and populates `./deno_dir` with npm dependencies
- it creates and populates `./vendor` with jsr + http dependencies

## Usage:

- Use the sources file as a source, example:

```yml
sources:
  - deno-sources.json
```

- To use `deno_dir` point `DENO_DIR` env variable to it, like so:

```yml
- name: someModule
  buildsystem: simple
  build-options:
    env:
      DENO_DIR: deno_dir
```

- To use `vendor` move it next to your `deno.json` file and make sure to compile
  or run with `--vendor` flag, exmaple:

```yml
- # src is where my deno project at
- mv ./vendor src/
- DENORT_BIN=$PWD/denort ./deno compile --vendor --no-check --output virtaudio-bin --cached-only
  --allow-all --include ./src/gui.slint --include ./src/client.html ./src/gui.ts
```

## Example
- checkout https://github.com/flathub/io.github.sigmasd.VirtAudio/
