# Warning

This Terraform directory is not production-authoritative.

Do not use it to manage the current live Vibes AWS environment.

Specifically, do not run any of the following against production from this folder:

- `terraform apply`
- `terraform destroy`
- `terraform import`
- `terraform state rm`
- `terraform state mv`

Why:

- the files here began as a minimal scaffold
- they have known drift from the live environment
- not every live AWS/EKS resource is modeled here
- applying this configuration to production could mutate or replace infrastructure unexpectedly

Current intended use:

- reference for future infrastructure codification
- development of a clean recreate/put-up/tear-down stack in a separate non-production environment
- rehearsal and validation before any production adoption

Safe process when you are ready:

1. inventory the actual live infrastructure
2. define the desired target architecture
3. build or refactor Terraform to match intentionally
4. test create/deploy/destroy on a separate cluster repeatedly
5. only then decide whether to adopt production into Terraform or rebuild under Terraform control
