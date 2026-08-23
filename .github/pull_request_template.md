## Co zmienia ten PR

<!-- Jedno-dwa zdania: co i po co. -->

## Wplyw na dzialajacy system

- [ ] Nie zmienia schematu bazy
- [ ] Zmienia schemat — dopisalem migracje NA KONCU tablicy i uruchomilem `migration-guard.mjs update`
- [ ] Zmiana jest wstecznie zgodna (stary kod dziala na nowym schemacie)
- [ ] Zadne dane uzytkownikow nie sa usuwane ani nadpisywane

## Testy

- [ ] `node --test tests/*.test.mjs` przechodzi
- [ ] `bash tests/smoke.sh` przechodzi
- [ ] Dopisalem test pokrywajacy te zmiane

## Do sprawdzenia na stagingu

<!-- Co konkretnie kliknac, zeby uwierzyc, ze dziala. -->
