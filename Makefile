ARM ?= both
RUNS ?= 1

# Export separately from the shell command so paths are not interpreted as shell syntax.
ifneq ($(origin REPO),undefined)
export PROMPTFOO_REPO := $(REPO)
endif

ARM_FILTER_with-skills := with-skills$$
ARM_FILTER_without-skills := without-skills$$
PROVIDER_FILTER = $(ARM_FILTER_$(ARM))

run-evals: .env
ifneq ($(origin BACKEND),undefined)
	$(error BACKEND has been removed; evaluations use Pi only. Omit BACKEND)
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
