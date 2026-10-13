# Compute Atlas data

`facilities.json` is the full Compute Atlas dataset in one file. It is regenerated from the
live database once per data wave. `facilities.meta.json` records when it was generated
(`asOf`) and how many records it holds. For current figures, use the
[API](https://www.compute-atlas.com/api) or [/api/stats](https://www.compute-atlas.com/api/stats).

## License and attribution

The data is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
([`LICENSE-DATA`](../LICENSE-DATA)). If you reuse it, credit it like this:

> Data from Compute Atlas by Edward Kubiak (https://www.compute-atlas.com), licensed under
> CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).

- **Link www.compute-atlas.com**, the dataset's home, rather than this repository.
- **Say what you changed.** For example: "filtered to data centers", "joined to counties", or
  "combined with our own research".
- **Keep your analysis distinct from the records.** Compute Atlas is non-partisan. It takes no
  position for or against any facility or operator, and it is not affiliated with any company,
  advocacy group, or government agency. Present your conclusions as yours.

For academic work, cite the DOI: Kubiak, E. (n.d.). *Compute Atlas* [Data set].
https://doi.org/10.5281/zenodo.22284476

## Reading the records

An empty field means "not established from a public source". It never means zero. The dataset
is curated, not a census, so a facility's absence is not evidence that it doesn't exist. Every
record cites its own sources and carries a confidence level. See the
[methodology](https://www.compute-atlas.com/methodology).
