run-evals: .env
	sops exec-env .env 'npx promptfoo@0.125.1 eval' 
.PHONY=run-evals

view-evals:
	npx promptfoo@0.125.1 view
.PHONY=view-evals

.env:
	@echo ".env file is missing"
	exit 1
