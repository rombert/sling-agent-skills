BACKEND ?= all
ARM ?= both

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
ifneq ($(PROVIDER_FILTER),)
	sops exec-env .env 'npx promptfoo@0.125.1 eval --no-cache --filter-providers "$(PROVIDER_FILTER)"'
else
	sops exec-env .env 'npx promptfoo@0.125.1 eval --no-cache'
endif
.PHONY: run-evals

view-evals:
	npx promptfoo@0.125.1 view
.PHONY: view-evals

.env:
	@echo ".env file is missing"
	exit 1
