use std::marker::PhantomData;

use glib::clone::Downgrade as _;
use glib::{Downgrade, Object};

#[test]
fn derive_downgrade() {
    #[derive(Downgrade)]
    pub struct NewType(Object);

    #[derive(Downgrade)]
    pub struct Struct {
        o1: Object,
        o2: std::rc::Rc<u32>,
    }

    #[derive(Downgrade)]
    pub enum Enum {
        None,
        Pair { x: Object, y: Object },
        Unit(),
        SingleUnnamed(Object),
        MultipleUnnamed(Object, Object, Object),
    }

    #[derive(Downgrade)]
    pub struct TypedWrapper<T>(Object, PhantomData<T>);

    #[derive(Downgrade)]
    pub enum TypedEnum<T> {
        This(Object, PhantomData<T>),
        That(Object, PhantomData<T>),
    }

    let object = Object::new::<Object>();
    let _ = NewType(object.clone()).downgrade();
    let _ = Struct {
        o1: object.clone(),
        o2: std::rc::Rc::new(1),
    }
    .downgrade();
    for value in [
        Enum::None,
        Enum::Pair {
            x: object.clone(),
            y: object.clone(),
        },
        Enum::Unit(),
        Enum::SingleUnnamed(object.clone()),
        Enum::MultipleUnnamed(object.clone(), object.clone(), object.clone()),
    ] {
        let _ = value.downgrade();
    }
    let _ = TypedWrapper::<u32>(object.clone(), PhantomData).downgrade();
    let _ = TypedEnum::<u32>::This(object.clone(), PhantomData).downgrade();
    let _ = TypedEnum::<u32>::That(object, PhantomData).downgrade();
}
