export const API_DOC = `# API Axonaut v2 — résumé

Base : https://axonaut.com/api/v2
Authentification : en-tête HTTP « userApiKey: <clé> » (géré par le serveur, jamais exposé).
Pagination : en-tête « page: <n> », 500 résultats par page. Sans page et avec trop de résultats, l'API répond 403 « Too many results » ;
cet outil relance alors automatiquement avec page=1. Tri : du plus récent au plus ancien (page 1 = les plus récents).

## Ressources (axonaut_list / axonaut_get)
companies, invoices, quotations, payments, expenses, expense-payments, suppliers, supplier-contracts,
supplier-deliveries, contracts, products, employees, opportunities, tasks, projects, tickets, events,
bank-transactions, bank-accounts, delivery-forms, diverse-operations, tax-rates, accounting-codes, users,
themes, pipes, payslips, company-categories, customfields, timetrackings, workforces, languages.

## Sous-ressources courantes (axonaut_get avec 'sub', ou axonaut_list avec company_id)
- /companies/{id}/addresses, /companies/{id}/employees, /companies/{id}/invoices, /companies/{id}/quotations ...
- /products/{id}/stock

## Filtres courants (paramètre 'query') — non exhaustifs, à vérifier selon la ressource
- date_after / date_before : dates au format JJ/MM/AAAA (ex. {"date_after":"01/01/2026"})
- name, email, siret, ... selon la ressource (voir la documentation officielle Axonaut)
- Un filtre inconnu est généralement ignoré par l'API : vérifier le nombre de résultats.

## Conseils
- Utilisez 'fields' pour limiter la taille des réponses (ex. ["id","number","date","company_name","total_amount","status"]).
- Les lignes de devis/factures (quotation_lines, invoice_lines) sont retirées par défaut des listes ; utilisez axonaut_get pour le détail d'un document.
- axonaut_request permet d'appeler n'importe quel endpoint ; les écritures sont bloquées si READ_ONLY=true.
`;
