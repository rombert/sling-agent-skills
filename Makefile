BACKEND ?= all
ARM ?= both
RUNS ?= 1

BACKEND_FILTER_pi := ^pi-
BACKEND_FILTER_native := ^cjs-
ARM_FILTER_with-skills := with-skills$$
ARM_FILTER_without-skills := without-skills$$
PROVIDER_FILTER = $(BACKEND_FILTER_$(BACKEND))$(ARM_FILTER_$(ARM))

run-evals: .env
ifeq ($(BACKEND),pi)
else ifeq ($(BACKEND),native)
else ifeq ($(BACKEND),all)
else
	$(error BACKEND must be pi, native, or all)
endif
ifeq ($(ARM),with-skills)
else ifeq ($(ARM),without-skills)
else ifneq ($(ARM),both)
	$(error ARM must be with-skills, without-skills, or both)
endif
ifneq ($(shell printf '%s\n' '$(RUNS)' | grep -Ec '^[1-9][0-9]*$$'),1)
	$(error RUNS must be a positive integer)
endif
ifneq ($(PROVIDER_FILTER),)
	sops exec-env .env 'npx promptfoo@0.125.1 eval --no-cache --repeat "$(RUNS)" --filter-providers "$(PROVIDER_FILTER)"'
else
	sops exec-env .env 'npx promptfoo@0.125.1 eval --no-cache --repeat "$(RUNS)"'
endif
.PHONY: run-evals

view-evals:
	npx promptfoo@0.125.1 view
.PHONY: view-evals

.env:
	@echo ".env file is missing"
	exit 1
