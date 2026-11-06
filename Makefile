.DEFAULT_GOAL := help
PROVIDER ?= promptfoo
SCENARIO ?= all
ARM ?= both
RUNS ?= 1
export EVAL_PROVIDER := $(PROVIDER)
export SCENARIO ARM RUNS
ifneq ($(origin EVAL_CONFIG),undefined)
export EVAL_CONFIG
endif

.PHONY: help list-evals generate-eval generate-evals run-eval run-evals test-evals view-evals
help:
	@echo 'make generate-eval [PROVIDER=promptfoo] [SCENARIO=id|all] [ARM=both|with-skills|without-skills]'
	@echo 'make run-eval      [same options] [RUNS=1]'
	@echo 'make test-evals    # Offline tests; no model calls or real Maven builds'
	@echo 'make list-evals    # Ready scenarios and pinned fixtures awaiting calibration'

list-evals:
	node evals/shared/scenarios.cjs

generate-eval:
	node evals/generate.cjs
generate-evals: generate-eval

run-eval: generate-eval
	node evals/run.cjs
run-evals: run-eval

test-evals:
	npm run test:evals

view-evals:
	node evals/view.cjs
