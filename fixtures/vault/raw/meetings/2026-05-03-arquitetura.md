# Reunião de arquitetura — 03/05/2026

Presentes: Ana Prado, Bruno Tavares.

Pauta: custo de operar o RabbitMQ no Projeto Atlas.

- O cluster de RabbitMQ pediu três intervenções manuais em abril.
- Bruno estimou 6 horas por mês de operação.
- Ana propôs migrar para SQS. Ninguém se opôs.
- Risco levantado: o SQS padrão entrega a mesma mensagem mais de uma vez; os consumidores precisam ser idempotentes.

Decisão: migrar para SQS até o fim de maio.
